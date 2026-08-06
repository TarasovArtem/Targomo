#!/usr/bin/env node
/**
 * QA Failure Analyzer
 *
 * reports/ai/context.json -> OpenAI API (Structured Outputs) -> reports/ai/ai-report.json
 *
 * Security:
 *  - The API key is read ONLY from process.env.OPENAI_API_KEY. It is never
 *    hardcoded, never written to a file, and never logged (including in
 *    error paths - only err.status/err.message are surfaced, never raw
 *    error/request objects).
 *  - Makes exactly one outbound call, to the OpenAI API, with exactly the
 *    contents of context.json (already scoped/size-capped by
 *    scripts/ai/collect-context.js). No other network access.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { CLASSIFICATIONS, buildSystemPrompt, buildUserPrompt, RESPONSE_SCHEMA } = require("./qa-agent-prompt");

const ROOT = path.resolve(__dirname, "..", "..");
const CONTEXT_FILE = path.join(ROOT, "reports", "ai", "context.json");
const HISTORY_FILE = path.join(ROOT, "reports", "ai", "history.json");
const OUTPUT_FILE = path.join(ROOT, "reports", "ai", "ai-report.json");

// Single source of truth for the model name - do not reference a model
// string anywhere else in this file or in qa-agent-prompt.js.
const DEFAULT_MODEL = "gpt-4o-mini";
const MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;

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
// the model.
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

function requireApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !key.trim()) {
    throw new AnalyzerError(
      "OPENAI_API_KEY environment variable is not set. Set it (e.g. as a CI/repo secret) before running npm run ai:analyze."
    );
  }
  return key;
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
// Structured Outputs makes the model's JSON *shape* reliable, but we still
// validate the actual values (enum membership, confidence range, non-empty
// strings) before ever writing ai-report.json - "invalid structure" from
// the model should fail loudly, not produce a malformed artifact.

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
// trusting the model.
const ARBITRARY_WAIT_PATTERN = /\bcy\.wait\(\s*\d+\s*\)|waitForTimeout\(\s*\d+\s*\)/i;

function recommendsArbitraryWait(item) {
  const text = (item.recommendedFix && item.recommendedFix.description) || "";
  return ARBITRARY_WAIT_PATTERN.test(text);
}

// Retried: rate limiting, server-side/gateway errors, and anything that
// never got an HTTP response at all (network blip, timeout). NOT retried:
// 4xx errors like 401 (bad key) or 400 (bad request) - those fail exactly
// the same way every time, so retrying would only add latency before the
// same clear error.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableError(err) {
  if (!err) return false;
  if (typeof err.status === "number") return RETRYABLE_STATUS_CODES.has(err.status);
  return true;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `client`/`sleep` are injectable for testing; production calls always use
// the real OpenAI client and a real timer.
async function callOpenAI(
  apiKey,
  context,
  { client, maxAttempts = 3, retryDelaysMs = [500, 1500], sleep = defaultSleep } = {}
) {
  const openai = client || new OpenAI({ apiKey });

  let response;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(context) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "qa_failure_analysis",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !isRetryableError(err)) break;
      await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1]);
    }
  }

  if (lastErr) {
    // Deliberately surface only status/message - never the raw error/request
    // object, which could otherwise leak request metadata into CI logs.
    const status = lastErr.status ? ` (HTTP ${lastErr.status})` : "";
    throw new AnalyzerError(`OpenAI API request failed${status}: ${lastErr.message || "unknown error"}`);
  }

  const raw = response && response.choices && response.choices[0] && response.choices[0].message.content;
  if (!raw) {
    throw new AnalyzerError("OpenAI response did not include any content.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AnalyzerError(`OpenAI response was not valid JSON: ${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new AnalyzerError('OpenAI response did not match the expected schema (missing "results" array).');
  }

  return { results: parsed.results, usage: response.usage || null };
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

  let apiKey;
  try {
    apiKey = requireApiKey();
  } catch (err) {
    fail(err.message);
    return;
  }

  // Optional flaky-test signal (see collect-history.js). Attached onto the
  // same context object buildUserPrompt already reads from, so a missing
  // reports/ai/history.json changes nothing else about this run.
  const history = readHistory();
  if (history) context.history = history;

  let results, usage;
  try {
    ({ results, usage } = await callOpenAI(apiKey, context));
  } catch (err) {
    fail(err.message);
    return;
  }

  if (results.length !== failedTests.length) {
    fail(
      `OpenAI returned ${results.length} result(s) but context.json has ${failedTests.length} failed test(s).`
    );
    return;
  }

  const structureErrors = results.flatMap((item, i) => validateAnalysisItem(item, i));
  if (structureErrors.length > 0) {
    fail(`OpenAI response failed validation:\n  - ${structureErrors.join("\n  - ")}`);
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
    // Same compact counts the model saw, kept on the report for
    // traceability - not the raw per-run data (there isn't any to keep;
    // collect-history.js never persists more than these aggregates).
    history,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens ?? null,
          completionTokens: usage.completion_tokens ?? null,
          totalTokens: usage.total_tokens ?? null,
        }
      : null,
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
  callOpenAI,
  validateAnalysisItem,
  recommendsArbitraryWait,
  isRetryableError,
  pickSourceContext,
  readHistory,
  MODEL,
};
