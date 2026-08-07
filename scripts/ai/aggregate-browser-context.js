#!/usr/bin/env node
/**
 * Browser input aggregator for the centralized QA AI triage job.
 *
 * Each Cypress browser matrix leg (chrome, edge) uploads its own small,
 * browser-scoped artifact (browser-result.json always; context.json/
 * history.json only when that leg actually failed - see
 * .github/workflows/cypress.yml). This script runs downstream, after both
 * legs have finished, once their artifacts have been downloaded into
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
 * "chrome was analyzed, edge also failed" - but they are not sent to the
 * AI provider and don't influence its classification. Real multi-browser
 * correlation reasoning is an explicit follow-up (not this PR).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BROWSER_INPUTS_DIR = path.join(ROOT, "reports", "ai", "browser-inputs");
const CONTEXT_FILE = path.join(ROOT, "reports", "ai", "context.json");
const HISTORY_FILE = path.join(ROOT, "reports", "ai", "history.json");

// Matches the CI matrix declared in .github/workflows/cypress.yml
// (browser: [chrome, edge]) - also doubles as the default priority order
// used to deterministically pick a primary browser when more than one
// failed, so the same input always yields the same choice.
const DEFAULT_BROWSER_PRIORITY = ["chrome", "edge"];

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

// Composes the two decisions above into the one result main() (and tests)
// actually need: whether to run at all, which browser is primary, and
// which other browsers also failed (logged only - never analyzed).
function aggregateBrowserInputs(browserInputs, priorityOrder = DEFAULT_BROWSER_PRIORITY) {
  if (!shouldRunAiTriage(browserInputs)) {
    return { shouldRun: false, primary: null, otherFailedBrowsers: [] };
  }

  const primary = selectPrimaryFailure(browserInputs, priorityOrder);
  const otherFailedBrowsers = browserInputs
    .filter((b) => b.outcome === "failure" && (!primary || b.browser !== primary.browser))
    .map((b) => b.browser);

  return { shouldRun: true, primary, otherFailedBrowsers };
}

function main() {
  const browserInputs = readBrowserInputs();
  const { shouldRun, primary, otherFailedBrowsers } = aggregateBrowserInputs(browserInputs);

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

  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(primary.context, null, 2));
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
  DEFAULT_BROWSER_PRIORITY,
};
