#!/usr/bin/env node
/**
 * QA Failure Analyzer
 *
 * reports/ai/context.json -> GitHub Models -> reports/ai/ai-report.json
 *
 * Security:
 *  - The auth token is read ONLY from process.env.GITHUB_TOKEN - the
 *    automatic per-run GitHub Actions token (or a developer's own token
 *    when running locally), never a separate paid-API credential. It is
 *    never hardcoded, never written to a file, and never logged (including
 *    in error paths - only status/message are surfaced, never raw
 *    error/request/response objects).
 *  - Makes exactly one outbound call, to GitHub Models, with exactly the
 *    contents of context.json (already scoped/size-capped by
 *    scripts/ai/collect-context.js). No other network access.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { MODEL, GITHUB_MODELS_ENDPOINT, PROVIDER_PAUSED_REASON } = require("./config");
const { CLASSIFICATIONS, buildSystemPrompt, buildUserPrompt } = require("./qa-agent-prompt");

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

// GITHUB_TOKEN is present automatically in every GitHub Actions run
// (scoped by the workflow's `permissions:` block) - this only fails
// locally, where a developer hasn't exported one themselves.
function requireGitHubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !token.trim()) {
    throw new AnalyzerError(
      "GitHub Models authentication token is missing. Set GITHUB_TOKEN before running npm run ai:analyze " +
        "(in CI this is automatic via `env: GITHUB_TOKEN: ${{ github.token }}`; locally, export your own token if you want to run this)."
    );
  }
  return token;
}

// Used only when PROVIDER_PAUSED_REASON is set (see config.js) - a
// synthesized, honest "we didn't actually analyze this" result per failed
// test, not a fabricated analysis. classification: UNKNOWN + confidence: 0
// is the correct, existing vocabulary for "insufficient evidence" - here
// the "evidence" that's missing is an AI provider to call at all. Reuses
// the exact same shape validateAnalysisItem() already enforces, so this
// stub is held to the same contract as a real model response and flows
// through the untouched PR-comment/artifact pipeline unchanged.
function buildPausedResult(failedTest) {
  return {
    test: { title: failedTest.title || null, specFile: failedTest.specFile || null },
    classification: "UNKNOWN",
    confidence: 0,
    summary: "AI analysis did not run for this failure.",
    rootCause: PROVIDER_PAUSED_REASON,
    evidence: [],
    recommendedFix: null,
    shouldCreateBug: false,
    shouldRetry: false,
  };
}

function buildPausedReport(context, failedTests) {
  return {
    generatedAt: new Date().toISOString(),
    model: null,
    sourceContext: pickSourceContext(context),
    history: null,
    usage: null,
    results: failedTests.map(buildPausedResult),
    warnings: [],
    note: `AI analysis is paused: ${PROVIDER_PAUSED_REASON}`,
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
// No structured-output schema is enforced on the request (see
// qa-agent-prompt.js) - GitHub Models proxies multiple model families and
// strict JSON-schema constraints aren't guaranteed to be honored
// identically by all of them. So the model's JSON shape is NOT trusted:
// every value is validated by hand (enum membership, confidence range,
// non-empty strings) before ever writing ai-report.json.

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
// 4xx errors like 401/403 (bad/insufficient token) or 400 (bad request) -
// those fail exactly the same way every time, so retrying would only add
// latency before the same clear error.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Models occasionally wrap JSON in a markdown code fence despite being
// told not to (see the OUTPUT FORMAT instruction in qa-agent-prompt.js).
// Strip that defensively rather than failing outright - the prompt is the
// primary control, this is the fallback.
function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

// `fetchImpl`/`sleep` are injectable for testing; production calls always
// use the real global fetch and a real timer.
async function callGitHubModels(
  token,
  context,
  { fetchImpl = fetch, maxAttempts = 3, retryDelaysMs = [500, 1500], sleep = defaultSleep } = {}
) {
  let response;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(GITHUB_MODELS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserPrompt(context) },
          ],
        }),
      });
    } catch (err) {
      // Never got a response at all (network blip, timeout) - worth retrying.
      lastErr = err;
      if (attempt === maxAttempts) break;
      await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1]);
      continue;
    }

    if (res.ok) {
      response = await res.json();
      lastErr = null;
      break;
    }

    const statusText = res.status === 429 ? "GitHub Models rate limit reached" : res.statusText;
    lastErr = new AnalyzerError(`GitHub Models API request failed (HTTP ${res.status}): ${statusText}`);
    lastErr.status = res.status;
    if (attempt === maxAttempts || !isRetryableStatus(res.status)) break;
    await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1]);
  }

  if (lastErr) {
    // Deliberately surface only status/message - never the raw error/request
    // object, which could otherwise leak request metadata (including the
    // Authorization header) into CI logs.
    if (lastErr instanceof AnalyzerError) throw lastErr;
    throw new AnalyzerError(`GitHub Models API request failed: ${lastErr.message || "unknown error"}`);
  }

  const raw = response && response.choices && response.choices[0] && response.choices[0].message.content;
  if (!raw) {
    throw new AnalyzerError("GitHub Models response did not include any content.");
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch (err) {
    throw new AnalyzerError(`GitHub Models response was not valid JSON: ${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new AnalyzerError('GitHub Models response did not match the expected shape (missing "results" array).');
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

  // Short-circuits before any network call, GITHUB_TOKEN check, or history
  // read - there is nothing to authenticate to or retry against a
  // permanently dead endpoint. See PROVIDER_PAUSED_REASON in config.js.
  if (PROVIDER_PAUSED_REASON) {
    const pausedReport = buildPausedReport(context, failedTests);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(pausedReport, null, 2));
    console.log(`[ai:analyze] AI analysis is paused: ${PROVIDER_PAUSED_REASON}`);
    console.log(`[ai:analyze] wrote ${path.relative(ROOT, OUTPUT_FILE)} (${pausedReport.results.length} stub result(s)).`);
    return;
  }

  let token;
  try {
    token = requireGitHubToken();
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
    ({ results, usage } = await callGitHubModels(token, context));
  } catch (err) {
    fail(err.message);
    return;
  }

  if (results.length !== failedTests.length) {
    fail(
      `GitHub Models returned ${results.length} result(s) but context.json has ${failedTests.length} failed test(s).`
    );
    return;
  }

  const structureErrors = results.flatMap((item, i) => validateAnalysisItem(item, i));
  if (structureErrors.length > 0) {
    fail(`GitHub Models response failed validation:\n  - ${structureErrors.join("\n  - ")}`);
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
  callGitHubModels,
  validateAnalysisItem,
  recommendsArbitraryWait,
  isRetryableStatus,
  stripCodeFences,
  pickSourceContext,
  readHistory,
  buildPausedResult,
  buildPausedReport,
  MODEL,
};
