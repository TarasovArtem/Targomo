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
 * scripts/ai/providers/. Swapping which provider is used (currently only
 * MockProvider - see scripts/ai/providers/) is a scripts/ai/providers/
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
const { MODEL } = require("./config");
const { CLASSIFICATIONS, buildSystemPrompt, buildUserPrompt } = require("./qa-agent-prompt");
const { createProvider } = require("./providers");
const { ProviderError } = require("./providers/provider-error");

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
// detail, only that one generic, provider-neutral signal. `sleep` is
// injectable for testing.
async function runProviderAnalysis(
  provider,
  context,
  { maxAttempts = 3, retryDelaysMs = [500, 1500], sleep = defaultSleep } = {}
) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(context);

  let raw;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      raw = await provider.analyze({ systemPrompt, userPrompt });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof ProviderError ? err.retryable : false;
      if (attempt === maxAttempts || !retryable) break;
      await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1]);
    }
  }

  if (lastErr) {
    // Deliberately surface only code/message - never the raw provider
    // error/request object, which could otherwise leak request metadata
    // (e.g. an Authorization header a real provider set) into CI logs.
    const code = lastErr instanceof ProviderError && lastErr.code ? ` (${lastErr.code})` : "";
    throw new AnalyzerError(`AI provider request failed${code}: ${lastErr.message || "unknown error"}`);
  }

  if (!raw || typeof raw !== "string" || !raw.trim()) {
    throw new AnalyzerError("AI provider response did not include any content.");
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

  const failedTests = context.failedTests || [];
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  if (failedTests.length === 0) {
    const emptyReport = {
      generatedAt: new Date().toISOString(),
      model: MODEL,
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

  let provider;
  try {
    provider = createProvider();
  } catch (err) {
    fail(err.message);
    return;
  }

  // Optional flaky-test signal (see collect-history.js). Attached onto the
  // same context object buildUserPrompt already reads from, so a missing
  // reports/ai/history.json changes nothing else about this run.
  const history = readHistory();
  if (history) context.history = history;

  let results;
  try {
    ({ results } = await runProviderAnalysis(provider, context));
  } catch (err) {
    fail(err.message);
    return;
  }

  if (results.length !== failedTests.length) {
    fail(`AI provider returned ${results.length} result(s) but context.json has ${failedTests.length} failed test(s).`);
    return;
  }

  const structureErrors = results.flatMap((item, i) => validateAnalysisItem(item, i));
  if (structureErrors.length > 0) {
    fail(`AI provider response failed validation:\n  - ${structureErrors.join("\n  - ")}`);
    return;
  }

  const warnings = [];
  results.forEach((item, i) => {
    if (recommendsArbitraryWait(item)) {
      warnings.push(
        `results[${i}] (${(item.test && item.test.title) || "unknown test"}) recommends a fixed-duration wait; review before applying - prefer deterministic synchronization.`
      );
    }
  });

  const report = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    sourceContext: pickSourceContext(context),
    // Same compact counts the provider saw, kept on the report for
    // traceability - not the raw per-run data (there isn't any to keep;
    // collect-history.js never persists more than these aggregates).
    history,
    results,
    warnings,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`[ai:analyze] wrote ${path.relative(ROOT, OUTPUT_FILE)} (${results.length} result(s)).`);
  for (const w of warnings) console.log(`[ai:analyze] warning: ${w}`);
}

if (require.main === module) {
  main().catch((err) => {
    fail((err && err.message) || String(err));
  });
}

module.exports = {
  runProviderAnalysis,
  validateAnalysisItem,
  recommendsArbitraryWait,
  stripCodeFences,
  pickSourceContext,
  readHistory,
  MODEL,
};
