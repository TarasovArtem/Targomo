#!/usr/bin/env node
/**
 * QA Failure Analyzer
 *
 * reports/ai/context.json -> AI provider -> reports/ai/ai-report.json
 *
 * Provider-neutral orchestration only:
 *
 *   read failure context -> build QA prompt -> get provider ->
 *   provider.analyze() -> parse JSON -> validate result ->
 *   apply QA-specific safeguards -> write ai-report.json
 *
 * This file never knows an API endpoint URL, request/header format, or
 * auth scheme for any AI provider - that all lives behind the
 * provider.analyze({systemPrompt, userPrompt}) contract in
 * scripts/ai/providers/ (MockProvider for local dev/tests, GroqProvider in
 * GitHub Actions - see scripts/ai/providers/index.js). Swapping which
 * provider is used, or adding another one, is a scripts/ai/providers/
 * change, not an analyze-failure.js change.
 *
 * Security:
 *  - Any provider credential is that provider implementation's own
 *    responsibility to read/validate/never-log - this file never handles
 *    one directly.
 *  - Makes at most one provider call, with exactly the contents of
 *    context.json (already scoped/size-capped by
 *    scripts/ai/collect-context.js).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { MODEL, PROVIDER } = require("./config");
const { CLASSIFICATIONS, buildSystemPrompt, buildUserPrompt } = require("./qa-agent-prompt");
const { createProvider } = require("./providers");
const { normalizeProviderError } = require("./providers/provider-error");
const { validateProvider, validateProviderResponse } = require("./providers/provider-contract");
const { applyAgentPolicy } = require("./agent-policy");
const { loadKnowledgeUnits } = require("./knowledge/loader");
const { selectKnowledge } = require("./knowledge/selector");

const ROOT = path.resolve(__dirname, "..", "..");
const CONTEXT_FILE = path.join(ROOT, "reports", "ai", "context.json");
const HISTORY_FILE = path.join(ROOT, "reports", "ai", "history.json");
const OUTPUT_FILE = path.join(ROOT, "reports", "ai", "ai-report.json");

class AnalyzerError extends Error {}

function readContext() {
  if (!fs.existsSync(CONTEXT_FILE)) {
    throw new AnalyzerError(
      `${path.relative(ROOT, CONTEXT_FILE)} not found. Run "npm run ai:collect" (after a test run) first.`
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(CONTEXT_FILE, "utf8");
  } catch (err) {
    throw new AnalyzerError(`Could not read ${path.relative(ROOT, CONTEXT_FILE)}: ${err.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new AnalyzerError(`${path.relative(ROOT, CONTEXT_FILE)} is not valid JSON: ${err.message}`);
  }
}

// Optional by design (see collect-history.js): missing file, unparseable
// JSON, or an { available: false } marker all just mean "no history" -
// never an error. Only the compact aggregate counts are kept; internal
// bookkeeping fields (available/reason/branch/generatedAt) aren't sent to
// the provider.
function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return null;
  }

  if (!parsed || parsed.available !== true) return null;

  return {
    runsConsidered: parsed.runsConsidered ?? null,
    passes: parsed.passes ?? null,
    failures: parsed.failures ?? null,
    retryPasses: parsed.retryPasses ?? null,
  };
}

// Deterministic, offline QA Knowledge selection (Roadmap #16A) - reuses
// Roadmap #15's loader/selector directly rather than duplicating their
// logic. Adds zero provider/network calls: loadKnowledgeUnits() is local
// filesystem-only (throws loudly on a malformed curated unit - see
// knowledge/loader.js - never silently skips one), selectKnowledge() is a
// pure, synchronous, in-memory function - see scripts/ai/knowledge/. Named
// and exported (like readHistory() below) so tests can inject a fixed
// result instead of touching the real scripts/ai/knowledge/units/ corpus.
function computeRelevantKnowledge(context) {
  return selectKnowledge(context, loadKnowledgeUnits());
}

function pickSourceContext(context) {
  const m = context.metadata || {};
  return {
    repository: m.repository ?? null,
    commit: m.commit ?? null,
    branch: m.branch ?? null,
    runId: m.runId ?? null,
    event: m.event ?? null,
    browser: m.browser ?? null,
    ci: m.ci ?? null,
    contextGeneratedAt: context.generatedAt || null,
    // Deterministic cross-browser correlation metadata (see PR #33's
    // aggregate-browser-context.js) - carried through onto ai-report.json
    // unchanged, the same way it was already carried into the prompt (see
    // qa-agent-prompt.js), purely for observability: future
    // evaluation/tooling can tell single- from multi-browser failures
    // without re-deriving it. null for contexts that weren't produced by
    // the aggregator (e.g. a local run).
    browserCorrelation: context.browserCorrelation ?? null,
    // The EXACT QA Knowledge units this analysis's provider call actually
    // received (Roadmap #16C) - read directly off context.relevantKnowledge
    // (already attached in buildFailureReport(), before runProviderAnalysis
    // ever ran), never recomputed via a second selectKnowledge() call here.
    // Recomputing would risk drifting from what the model actually saw if
    // the corpus changed between analysis and report-building, however
    // unlikely - reading the same value already threaded through the
    // prompt is the only way to guarantee this field is truthful. Always
    // an array (never omitted): [] is a meaningful, intentional signal
    // that no curated knowledge matched this run, not an absence of data.
    relevantKnowledge: context.relevantKnowledge ?? [],
  };
}

// --- response validation --------------------------------------------------
// No structured-output schema is enforced on the provider call - not
// every provider is guaranteed to honor one identically. So the
// provider's JSON shape is NOT trusted: every value is validated by hand
// (enum membership, confidence range, non-empty strings) before ever
// writing ai-report.json.

function isFiniteNumberInRange(n, min, max) {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function validateAnalysisItem(item, index) {
  const errors = [];
  const prefix = `results[${index}]`;

  if (!item || typeof item !== "object") {
    return [`${prefix} is not an object`];
  }
  if (!item.test || typeof item.test.title !== "string") {
    errors.push(`${prefix}.test.title must be a string`);
  }
  if (!CLASSIFICATIONS.includes(item.classification)) {
    errors.push(`${prefix}.classification must be one of ${CLASSIFICATIONS.join(", ")}`);
  }
  if (!isFiniteNumberInRange(item.confidence, 0, 1)) {
    errors.push(`${prefix}.confidence must be a number between 0 and 1`);
  }
  if (typeof item.summary !== "string" || !item.summary.trim()) {
    errors.push(`${prefix}.summary must be a non-empty string`);
  }
  if (typeof item.rootCause !== "string" || !item.rootCause.trim()) {
    errors.push(`${prefix}.rootCause must be a non-empty string`);
  }
  if (!Array.isArray(item.evidence) || item.evidence.some((e) => typeof e !== "string")) {
    errors.push(`${prefix}.evidence must be an array of strings`);
  }
  if (item.recommendedFix !== null) {
    if (!item.recommendedFix || typeof item.recommendedFix.description !== "string") {
      errors.push(`${prefix}.recommendedFix must be null or an object with a "description" string`);
    }
  }
  if (typeof item.shouldCreateBug !== "boolean") {
    errors.push(`${prefix}.shouldCreateBug must be a boolean`);
  }
  if (typeof item.shouldRetry !== "boolean") {
    errors.push(`${prefix}.shouldRetry must be a boolean`);
  }

  return errors;
}

// Defense-in-depth against the one recommendation style the agent is
// explicitly told not to make. The prompt is the primary control; this is
// a non-blocking safety net that surfaces a warning instead of silently
// trusting the provider.
const ARBITRARY_WAIT_PATTERN = /\bcy\.wait\(\s*\d+\s*\)|waitForTimeout\(\s*\d+\s*\)/i;

function recommendsArbitraryWait(item) {
  const text = (item.recommendedFix && item.recommendedFix.description) || "";
  return ARBITRARY_WAIT_PATTERN.test(text);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Providers occasionally wrap JSON in a markdown code fence despite being
// told not to (see the OUTPUT FORMAT instruction in qa-agent-prompt.js).
// Strip that defensively rather than failing outright - the prompt is the
// primary control, this is the fallback. Provider-neutral: not specific
// to any one provider's response format.
function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

// Bounded retry around a single provider.analyze() call. Providers signal
// "this specific failure is worth retrying" via ProviderError's
// `retryable` flag (see providers/provider-error.js) - this orchestration
// layer never inspects an HTTP status code or any other provider-specific
// detail, only that one generic, provider-neutral signal. Any exception a
// provider throws - whether it's already a ProviderError or an ordinary
// Error escaping a buggy implementation - is normalized to a ProviderError
// before that decision is made, so this loop only ever has one error shape
// to reason about. `sleep` is injectable for testing.
async function runProviderAnalysis(
  provider,
  context,
  { maxAttempts = 3, retryDelaysMs = [500, 1500], sleep = defaultSleep } = {}
) {
  // A provider missing analyze() (or not an object at all) can never
  // succeed on retry - fail once, clearly, before spending any attempts.
  validateProvider(provider);

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(context);

  let raw;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await provider.analyze({ systemPrompt, userPrompt });
      validateProviderResponse(response);
      raw = response;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = normalizeProviderError(err);
      if (attempt === maxAttempts || !lastErr.retryable) break;
      await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1]);
    }
  }

  if (lastErr) {
    // Deliberately surface only code/message - never the raw provider
    // error/request object (or its .cause), which could otherwise leak
    // request metadata (e.g. an Authorization header a real provider set)
    // into CI logs.
    const code = lastErr.code ? ` (${lastErr.code})` : "";
    throw new AnalyzerError(`AI provider request failed${code}: ${lastErr.message || "unknown error"}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch (err) {
    throw new AnalyzerError(`AI provider response was not valid JSON: ${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new AnalyzerError('AI provider response did not match the expected shape (missing "results" array).');
  }

  return { results: parsed.results };
}

// Builds the full ai-report.json object for a context that has at least
// one failed test - the one piece of orchestration logic worth testing
// independently of file I/O (see analyze-failure.test.js's pipeline test).
// `provider`/`history` are injectable so a test can supply a MockProvider
// and a fixed history value without touching process.env or the real
// reports/ai/history.json file; production (main(), below) always lets
// both default to their real implementations.
async function buildFailureReport(
  context,
  { provider = createProvider(), history = readHistory(), relevantKnowledge = computeRelevantKnowledge(context) } = {}
) {
  const failedTests = context.failedTests || [];
  const generatedAt = new Date().toISOString();

  // Optional flaky-test signal (see collect-history.js). Attached onto the
  // same context object buildUserPrompt already reads from, so a missing
  // reports/ai/history.json changes nothing else about this run.
  if (history) context.history = history;

  // Deterministic QA Knowledge selection (Roadmap #16A), attached onto the
  // same context object exactly like history above - buildUserPrompt (via
  // runProviderAnalysis below) reads context.relevantKnowledge the same
  // way it already reads context.browserCorrelation/knownProjectConstraints.
  // Always an array (selectKnowledge() never returns null), so this is an
  // unconditional assignment, unlike history's `if (history)` guard.
  context.relevantKnowledge = relevantKnowledge;

  const { results } = await runProviderAnalysis(provider, context);

  if (results.length !== failedTests.length) {
    throw new AnalyzerError(
      `AI provider returned ${results.length} result(s) but context.json has ${failedTests.length} failed test(s).`
    );
  }

  const structureErrors = results.flatMap((item, i) => validateAnalysisItem(item, i));
  if (structureErrors.length > 0) {
    throw new AnalyzerError(`AI provider response failed validation:\n  - ${structureErrors.join("\n  - ")}`);
  }

  // LLM proposes, application policy decides (see scripts/ai/agent-policy.js):
  // only after this point do "results" reflect what the application
  // actually decided is allowed, not just what the provider recommended.
  // Applied to every result, not just the first - a report can cover more
  // than one failed test. Logged here (not inside the pure policy module
  // itself) only when an intervention actually happened, to avoid noise.
  const policySafeResults = results.map(applyAgentPolicy);
  policySafeResults.forEach((item, i) => {
    if (item.policy.adjusted) {
      console.log(`[ai:policy] Overrode shouldCreateBug=true for classification ${item.classification} (results[${i}]).`);
    }
  });

  const warnings = [];
  policySafeResults.forEach((item, i) => {
    if (recommendsArbitraryWait(item)) {
      warnings.push(
        `results[${i}] (${(item.test && item.test.title) || "unknown test"}) recommends a fixed-duration wait; review before applying - prefer deterministic synchronization.`
      );
    }
  });

  return {
    generatedAt,
    model: MODEL,
    // Application-attributed metadata about the analysis run itself -
    // added here, after the model response has already been validated,
    // never inside the LLM-generated JSON schema (a provider has no
    // business asserting its own name; the application already knows it).
    // Kept as its own object rather than replacing the existing top-level
    // generatedAt/model fields so format-pr-comment.js's existing
    // `report.model` read keeps working unchanged.
    analysis: { provider: provider.name || "unknown", generatedAt },
    sourceContext: pickSourceContext(context),
    // Same compact counts the provider saw, kept on the report for
    // traceability - not the raw per-run data (there isn't any to keep;
    // collect-history.js never persists more than these aggregates).
    history,
    results: policySafeResults,
    warnings,
  };
}

function fail(message) {
  console.error(`[ai:analyze] Error: ${message}`);
  process.exitCode = 1;
}

async function main() {
  let context;
  try {
    context = readContext();
  } catch (err) {
    fail(err.message);
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  const failedTests = context.failedTests || [];
  if (failedTests.length === 0) {
    const emptyReport = {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      analysis: null,
      sourceContext: pickSourceContext(context),
      history: null,
      results: [],
      warnings: [],
      note: "No failed tests were present in reports/ai/context.json; nothing to analyze.",
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(emptyReport, null, 2));
    console.log(`[ai:analyze] No failed tests to analyze. Wrote ${path.relative(ROOT, OUTPUT_FILE)}.`);
    return;
  }

  // Safe to log: provider/model are configuration, never a credential.
  // Never add AI_API_KEY (or anything derived from it) to this or any
  // other log line in this file.
  console.log(`[ai:analyze] AI provider: ${PROVIDER} · model: ${MODEL || "not configured"}`);

  let report;
  try {
    report = await buildFailureReport(context);
  } catch (err) {
    fail(err.message);
    return;
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`[ai:analyze] wrote ${path.relative(ROOT, OUTPUT_FILE)} (${report.results.length} result(s)).`);
  for (const w of report.warnings) console.log(`[ai:analyze] warning: ${w}`);
}

if (require.main === module) {
  main().catch((err) => {
    fail((err && err.message) || String(err));
  });
}

module.exports = {
  runProviderAnalysis,
  buildFailureReport,
  validateAnalysisItem,
  recommendsArbitraryWait,
  stripCodeFences,
  pickSourceContext,
  readHistory,
  computeRelevantKnowledge,
  MODEL,
};
