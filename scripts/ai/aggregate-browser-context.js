#!/usr/bin/env node
/**
 * Browser input aggregator for the centralized QA AI triage job.
 *
 * Each Cypress browser job (cypress-tests' chrome/edge matrix legs, plus
 * the standalone firefox-tests job since Roadmap #14C) uploads its own
 * small, browser-scoped artifact (browser-result.json always; context.json/
 * history.json only when that leg actually failed - see
 * .github/workflows/cypress.yml). This script runs downstream, after every
 * browser job has finished, once their artifacts have been downloaded into
 * reports/ai/browser-inputs/<browser>/:
 *
 *   read every browser's result -> decide whether ANY of them failed ->
 *   if so, deterministically pick ONE primary failing browser -> copy
 *   its context.json/history.json into the exact paths analyze-failure.js
 *   already reads (reports/ai/context.json, reports/ai/history.json).
 *
 * This is intentionally a "pick one, don't merge" strategy, not a
 * multi-browser reasoning layer: analyze-failure.js, qa-agent-prompt.js,
 * and the provider contract are completely unaware this file exists and
 * need zero changes - they still see exactly the single-context.json
 * shape they always have. The result is that "AI provider.analyze()" is
 * called at most once per workflow run by construction, since there is
 * now exactly one place (this script, feeding the unmodified
 * analyze-failure.js) where that can happen at all - not because of any
 * new locking/dedup logic.
 *
 * Other browsers that also failed are not silently dropped - they're
 * logged (this script's own stdout) so a human reading CI logs can see
 * "chrome was analyzed, edge also failed" - and, since PR #33, also
 * summarized as deterministic "browserCorrelation" metadata (which
 * browsers ran, which failed/passed, single- vs multi-browser scope, and
 * whether failed browsers share the same evidence signature) attached to
 * the primary browser's context.json before analyze-failure.js ever runs.
 * This is still a "pick one context, don't merge results" strategy, not a
 * multi-browser reasoning layer of its own: the correlation object is
 * computed here, deterministically, from Cypress's own recorded outcomes -
 * never by an LLM - and is handed to the model as evidence alongside the
 * primary failure, not as a second analysis target. "AI provider.analyze()"
 * is still called at most once per workflow run, by the same construction
 * as before (this script feeds one context object to the unmodified
 * analyze-failure.js).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BROWSER_INPUTS_DIR = path.join(ROOT, "reports", "ai", "browser-inputs");
const CONTEXT_FILE = path.join(ROOT, "reports", "ai", "context.json");
const HISTORY_FILE = path.join(ROOT, "reports", "ai", "history.json");

// Matches the CI browsers declared in .github/workflows/cypress.yml
// (cypress-tests' matrix: [chrome, edge], plus firefox-tests since
// Roadmap #14C) - also doubles as the default priority order used to
// deterministically pick a primary browser when more than one failed, so
// the same input always yields the same choice. This is also the list
// readBrowserInputs() below actually looks for artifact directories under
// when main() calls it with no arguments (the real production path) - a
// browser missing from this list is invisible to aggregation entirely,
// not just deprioritized, regardless of whether that browser's job and
// artifact upload actually ran.
const DEFAULT_BROWSER_PRIORITY = ["chrome", "edge", "firefox"];

function log(message) {
  process.stdout.write(`[ai:aggregate] ${message}\n`);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Reads every known browser's downloaded input directory. A browser whose
// browser-result.json is missing or unreadable (artifact never uploaded,
// download failed, etc.) is simply left out of the returned list rather
// than treated as a failure or a crash - the decision functions below only
// ever reason about browsers we actually have a real outcome for.
function readBrowserInputs(baseDir = DEFAULT_BROWSER_INPUTS_DIR, browsers = DEFAULT_BROWSER_PRIORITY) {
  const inputs = [];

  for (const browser of browsers) {
    const dir = path.join(baseDir, browser);
    const result = readJsonIfExists(path.join(dir, "browser-result.json"));
    if (!result || (result.outcome !== "success" && result.outcome !== "failure")) continue;

    inputs.push({
      browser: result.browser || browser,
      outcome: result.outcome,
      context: readJsonIfExists(path.join(dir, "context.json")),
      history: readJsonIfExists(path.join(dir, "history.json")),
    });
  }

  return inputs;
}

// Pure decision: is there any E2E failure at all across the browsers we
// have data for? Never uses an LLM to answer this - it's a plain boolean
// derived from Cypress's own recorded outcome.
function shouldRunAiTriage(browserInputs) {
  return browserInputs.some((b) => b.outcome === "failure");
}

// Deterministically picks ONE failing browser to actually analyze,
// following priorityOrder. Falls back to the first failing browser found
// if none of the failing browsers are in priorityOrder (e.g. a matrix
// entry added later that this list hasn't been updated for yet) - failing
// open to "still run triage" rather than silently skipping it.
function selectPrimaryFailure(browserInputs, priorityOrder = DEFAULT_BROWSER_PRIORITY) {
  for (const browser of priorityOrder) {
    const match = browserInputs.find((b) => b.browser === browser && b.outcome === "failure");
    if (match) return match;
  }
  return browserInputs.find((b) => b.outcome === "failure") || null;
}

// Stable, array-based ordering: known browsers first (in priorityOrder),
// then any unrecognized ones alphabetically - so a future browser added to
// the matrix before this list is updated still sorts deterministically
// instead of depending on artifact-download/filesystem enumeration order.
function orderByPriority(browsers, priorityOrder) {
  const prioritized = priorityOrder.filter((b) => browsers.includes(b));
  const rest = browsers.filter((b) => !priorityOrder.includes(b)).sort();
  return [...prioritized, ...rest];
}

// error.message normalization only - deliberately NOT fuzzy/AI matching,
// just enough to avoid a trivial whitespace difference producing a false
// "different signature". Case and wording are otherwise compared exactly.
function normalizeForSignature(text) {
  return typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
}

// One browser's failure "signature": the sorted set of
// spec+test+normalized-error-message triples for every test it reported as
// failed. null (not an empty array) when that browser has no usable
// context/failedTests at all, so the caller can tell "no failures" apart
// from "we have no evidence to compare".
function buildFailureSignatureSet(browserContext) {
  const failedTests = (browserContext && browserContext.failedTests) || [];
  if (failedTests.length === 0) return null;

  return failedTests
    .map((t) => `${t.specFile || ""}::${t.fullTitle || t.title || ""}::${normalizeForSignature(t.error && t.error.message)}`)
    .sort();
}

function sameSignatureSet(a, b) {
  return a.length === b.length && a.every((sig, i) => sig === b[i]);
}

// Deterministic cross-browser comparison, scoped to THIS workflow run only
// (no persistent/cross-run fingerprint storage - see the module comment).
// Returns true/false only when every failed browser has comparable
// evidence; null ("unknown") whenever there are fewer than two failed
// browsers to compare, or any of them is missing usable failedTests data -
// never forced to false for lack of evidence.
function computeSameFailureSignature(browserInputs, failedBrowsers) {
  if (failedBrowsers.length < 2) return null;

  const signatureSets = failedBrowsers.map((browser) => {
    const input = browserInputs.find((b) => b.browser === browser);
    return buildFailureSignatureSet(input && input.context);
  });

  if (signatureSets.some((set) => set === null)) return null;

  const [first, ...rest] = signatureSets;
  return rest.every((set) => sameSignatureSet(first, set));
}

// Deterministic application-logic correlation metadata (see PR #33): built
// entirely from Cypress's own recorded per-browser outcomes, never by an
// LLM. Array-based throughout so this naturally extends to a future third
// (or Nth) browser without any chrome/edge-specific branching - only
// DEFAULT_BROWSER_PRIORITY's *ordering* still favors chrome/edge today.
function buildBrowserCorrelation(browserInputs, primary, priorityOrder = DEFAULT_BROWSER_PRIORITY) {
  const browsers = orderByPriority(browserInputs.map((b) => b.browser), priorityOrder);
  const failedBrowsers = orderByPriority(
    browserInputs.filter((b) => b.outcome === "failure").map((b) => b.browser),
    priorityOrder
  );
  const passedBrowsers = orderByPriority(
    browserInputs.filter((b) => b.outcome === "success").map((b) => b.browser),
    priorityOrder
  );
  const primaryBrowser = primary ? primary.browser : null;
  const additionalFailedBrowsers = failedBrowsers.filter((b) => b !== primaryBrowser);

  return {
    browsers,
    failedBrowsers,
    passedBrowsers,
    primaryBrowser,
    additionalFailedBrowsers,
    failureScope: failedBrowsers.length > 1 ? "multi-browser" : "single-browser",
    sameFailureSignature: computeSameFailureSignature(browserInputs, failedBrowsers),
  };
}

// Composes the decisions above into the one result main() (and tests)
// actually need: whether to run at all, which browser is primary, which
// other browsers also failed (logged only - never separately analyzed),
// and the deterministic cross-browser correlation metadata to attach to
// the primary context before it reaches the AI provider.
function aggregateBrowserInputs(browserInputs, priorityOrder = DEFAULT_BROWSER_PRIORITY) {
  if (!shouldRunAiTriage(browserInputs)) {
    return { shouldRun: false, primary: null, otherFailedBrowsers: [], correlation: null };
  }

  const primary = selectPrimaryFailure(browserInputs, priorityOrder);
  const otherFailedBrowsers = browserInputs
    .filter((b) => b.outcome === "failure" && (!primary || b.browser !== primary.browser))
    .map((b) => b.browser);
  const correlation = buildBrowserCorrelation(browserInputs, primary, priorityOrder);

  return { shouldRun: true, primary, otherFailedBrowsers, correlation };
}

function main() {
  const browserInputs = readBrowserInputs();
  const { shouldRun, primary, otherFailedBrowsers, correlation } = aggregateBrowserInputs(browserInputs);

  if (!shouldRun) {
    log("No E2E failures detected; AI triage skipped.");
    return;
  }

  if (!primary || !primary.context) {
    log(
      `A browser reported failure (${browserInputs
        .filter((b) => b.outcome === "failure")
        .map((b) => b.browser)
        .join(", ") || "unknown"}) but no usable context.json was found for it - cannot run AI triage.`
    );
    return;
  }

  // Still "pick one context" (primary.context's failedTests/relevantFiles/
  // etc. are untouched) - only a new browserCorrelation field is added, so
  // analyze-failure.js/qa-agent-prompt.js only need to opt into reading it,
  // never to change how they read everything else already on context.json.
  const contextWithCorrelation = { ...primary.context, browserCorrelation: correlation };

  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(contextWithCorrelation, null, 2));
  if (primary.history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(primary.history, null, 2));
  }

  const otherNote = otherFailedBrowsers.length
    ? ` Also failed: ${otherFailedBrowsers.join(", ")} (not separately analyzed in this run).`
    : "";
  log(`Selected '${primary.browser}' as the primary failing browser for AI triage.${otherNote}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  readBrowserInputs,
  shouldRunAiTriage,
  selectPrimaryFailure,
  aggregateBrowserInputs,
  buildBrowserCorrelation,
  DEFAULT_BROWSER_PRIORITY,
};
