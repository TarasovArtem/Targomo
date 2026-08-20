"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  runProviderAnalysis,
  buildFailureReport,
  validateAnalysisItem,
  recommendsArbitraryWait,
  stripCodeFences,
  summarizeProviderError,
  readHistory,
  computeRelevantKnowledge,
} = require("./analyze-failure");
const { ProviderError, PROVIDER_ERROR_CODES, normalizeProviderError } = require("./providers/provider-error");
const { MockProvider } = require("./providers/mock-provider");
const { CLASSIFICATIONS } = require("./qa-agent-prompt");
const { loadKnowledgeUnits } = require("./knowledge/loader");
const { selectKnowledge } = require("./knowledge/selector");

const ROOT = path.resolve(__dirname, "..", "..");
const HISTORY_FILE = path.join(ROOT, "reports", "ai", "history.json");

const context = {
  metadata: { repository: "o/r", commit: "abc123", branch: "main", runId: null, event: null, browser: "chrome", ci: false },
  testResults: { found: true, totals: { tests: 1, passed: 0, failed: 1, pending: 0, duration: 100 }, specs: [] },
  failedTests: [
    {
      title: "should remove subcategories from the DOM after collapsing the parent category",
      specFile: "cypress/e2e/tests/category_tree_behavior.cy.js",
      suite: "Category tree behavior",
      status: "failed",
      duration: 1400,
      error: { message: "AssertionError: ...", stack: "AssertionError: ...\n  at ..." },
      screenshot: null,
    },
  ],
  relevantFiles: {},
  warnings: [],
};

function goodItem(overrides = {}) {
  return {
    test: { title: context.failedTests[0].title, specFile: context.failedTests[0].specFile },
    classification: "TEST_BUG",
    confidence: 0.82,
    summary: "Summary.",
    rootCause: "Root cause.",
    evidence: ["err.message: AssertionError: ..."],
    recommendedFix: { file: context.failedTests[0].specFile, description: "Assert on a stable condition instead." },
    shouldCreateBug: false,
    shouldRetry: false,
    ...overrides,
  };
}

// A fake provider implementing only the minimal analyze() contract -
// mocking happens at the provider boundary, never at global.fetch, so
// these tests exercise runProviderAnalysis the same way any real provider
// eventually would.
function providerReturning(resultsPayload) {
  return { analyze: async () => JSON.stringify({ results: resultsPayload }) };
}

function providerThrowing(err) {
  return {
    analyze: async () => {
      throw err;
    },
  };
}

function providerFailingThenSucceeding(failCount, err, resultsPayload) {
  let calls = 0;
  return {
    analyze: async () => {
      calls += 1;
      if (calls <= failCount) throw err;
      return JSON.stringify({ results: resultsPayload });
    },
    get calls() {
      return calls;
    },
  };
}

const noopSleep = async () => {};

test("runProviderAnalysis: happy path returns results that pass validation", async () => {
  const { results } = await runProviderAnalysis(providerReturning([goodItem()]), context);
  assert.equal(results.length, 1);
  assert.deepEqual(validateAnalysisItem(results[0], 0), []);
  assert.equal(recommendsArbitraryWait(results[0]), false);
});

test("runProviderAnalysis: calls provider.analyze with a systemPrompt and userPrompt, nothing provider-specific", async () => {
  let captured;
  const provider = {
    analyze: async (args) => {
      captured = args;
      return JSON.stringify({ results: [goodItem()] });
    },
  };
  await runProviderAnalysis(provider, context);
  assert.equal(typeof captured.systemPrompt, "string");
  assert.equal(typeof captured.userPrompt, "string");
  assert.ok(captured.systemPrompt.length > 0);
  assert.ok(captured.userPrompt.length > 0);
});

test("runProviderAnalysis: strips a markdown code fence around the JSON if the provider added one anyway", async () => {
  const provider = { analyze: async () => "```json\n" + JSON.stringify({ results: [goodItem()] }) + "\n```" };
  const { results } = await runProviderAnalysis(provider, context);
  assert.equal(results.length, 1);
});

test("runProviderAnalysis: result count mismatch is left for the caller to detect", async () => {
  const { results } = await runProviderAnalysis(providerReturning([goodItem(), goodItem()]), context);
  assert.notEqual(results.length, context.failedTests.length);
});

test("validateAnalysisItem: rejects an invalid classification enum value", async () => {
  const { results } = await runProviderAnalysis(providerReturning([goodItem({ classification: "TOTALLY_MADE_UP" })]), context);
  const errors = validateAnalysisItem(results[0], 0);
  assert.ok(errors.some((e) => e.includes("classification")));
});

test("validateAnalysisItem: rejects out-of-range confidence", async () => {
  const { results } = await runProviderAnalysis(providerReturning([goodItem({ confidence: 1.5 })]), context);
  const errors = validateAnalysisItem(results[0], 0);
  assert.ok(errors.some((e) => e.includes("confidence")));
});

test("recommendsArbitraryWait: flags a fixed-duration wait recommendation", async () => {
  const { results } = await runProviderAnalysis(
    providerReturning([
      goodItem({ recommendedFix: { file: context.failedTests[0].specFile, description: "Just add cy.wait(5000) after the click." } }),
    ]),
    context
  );
  assert.equal(recommendsArbitraryWait(results[0]), true);
});

test("recommendsArbitraryWait: does not flag a deterministic-sync recommendation", () => {
  assert.equal(recommendsArbitraryWait(goodItem()), false);
});

test("stripCodeFences: strips a ```json fence, leaves plain JSON untouched", () => {
  assert.equal(stripCodeFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFences('{"a":1}'), '{"a":1}');
});

test("runProviderAnalysis: a non-retryable ProviderError surfaces cleanly, without leaking any secret it might carry", async () => {
  const err = new ProviderError("Unauthorized (401)", { code: 401, retryable: false });
  await assert.rejects(
    () => runProviderAnalysis(providerThrowing(err), context, { sleep: noopSleep }),
    (thrown) => {
      assert.match(thrown.message, /401/);
      assert.match(thrown.message, /Unauthorized/);
      return true;
    }
  );
});

test("runProviderAnalysis: a non-retryable error is never retried, even with attempts remaining", async () => {
  const provider = providerFailingThenSucceeding(99, new ProviderError("Forbidden", { code: 403, retryable: false }), [goodItem()]);
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(provider.calls, 1);
});

test("runProviderAnalysis: retries a retryable ProviderError and succeeds on a later attempt", async () => {
  const provider = providerFailingThenSucceeding(
    2,
    new ProviderError("Service Unavailable", { code: 503, retryable: true }),
    [goodItem()]
  );
  const { results } = await runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 });
  assert.equal(provider.calls, 3, "should have retried twice before succeeding on the third attempt");
  assert.equal(results.length, 1);
});

test("runProviderAnalysis: gives up after maxAttempts on a persistently retryable error", async () => {
  const provider = providerFailingThenSucceeding(99, new ProviderError("Internal Server Error", { code: 500, retryable: true }), [
    goodItem(),
  ]);
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(provider.calls, 3);
});

test("runProviderAnalysis: a plain (non-ProviderError) throw is treated as non-retryable", async () => {
  const provider = providerFailingThenSucceeding(99, new Error("boom"), [goodItem()]);
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(provider.calls, 1);
});

test("runProviderAnalysis: empty response content produces a clear error, not a crash", async () => {
  const provider = { analyze: async () => "" };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep }), /empty response/i);
});

test("runProviderAnalysis: a whitespace-only response is treated the same as empty", async () => {
  const provider = { analyze: async () => "   \n  " };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep }), /empty response/i);
});

test("runProviderAnalysis: a non-string response produces a clear error, not a crash", async () => {
  const provider = { analyze: async () => null };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep }), /invalid response type/i);
});

test("runProviderAnalysis: an object response (not yet a string) is rejected before ever reaching JSON.parse", async () => {
  const provider = { analyze: async () => ({ results: [goodItem()] }) };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep }), /invalid response type/i);
});

test("runProviderAnalysis: a provider object missing analyze() fails immediately with a clear error, no retries spent", async () => {
  let sleepCalls = 0;
  await assert.rejects(
    () => runProviderAnalysis({}, context, { sleep: async () => { sleepCalls += 1; }, maxAttempts: 3 }),
    (err) => {
      assert.match(err.message, /analyze\(\) function is required/);
      return true;
    }
  );
  assert.equal(sleepCalls, 0, "an invalid provider object should never be retried");
});

test("runProviderAnalysis: an invalid-response failure is not retried by default (INVALID_RESPONSE is non-retryable)", async () => {
  let calls = 0;
  const provider = {
    analyze: async () => {
      calls += 1;
      return "";
    },
  };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(calls, 1);
});

test("runProviderAnalysis: unexpected response shape (no results array) produces a clear error", async () => {
  const provider = { analyze: async () => JSON.stringify({ unexpected: true }) };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep }), /missing "results" array/);
});

test("runProviderAnalysis: invalid JSON in the response produces a clear error, not a fabricated analysis", async () => {
  const provider = { analyze: async () => "this is not json at all" };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep }), /not valid JSON/);
});

// --- Roadmap #18.3: provider-attempt provenance ----------------------------
//
// Purely additive bookkeeping alongside the existing retry loop above - none
// of these tests change when/why a retry happens, only what the already-
// existing loop state exposes on success. providerAttempts is the 1-based
// count of provider.analyze() calls actually made; firstAttemptError is the
// normalized error from the FIRST failed attempt only, never overwritten by
// a later attempt's error.

test("runProviderAnalysis: providerAttempts is 1 and firstAttemptError is null on immediate success", async () => {
  const { providerAttempts, firstAttemptError } = await runProviderAnalysis(providerReturning([goodItem()]), context);
  assert.equal(providerAttempts, 1);
  assert.equal(firstAttemptError, null);
});

test("runProviderAnalysis: one retryable failure then success - providerAttempts is 2, firstAttemptError describes attempt 1 only, using the fixed safe message for its code", async () => {
  const err = new ProviderError("Service Unavailable", { code: PROVIDER_ERROR_CODES.UNKNOWN, retryable: true });
  const provider = providerFailingThenSucceeding(1, err, [goodItem()]);
  const { providerAttempts, firstAttemptError } = await runProviderAnalysis(provider, context, {
    sleep: noopSleep,
    maxAttempts: 3,
  });
  assert.equal(provider.calls, 2);
  assert.equal(providerAttempts, 2);
  assert.deepEqual(firstAttemptError, { code: err.code, message: "Unknown provider error", retryable: true });
});

test("runProviderAnalysis: two retryable failures then success - providerAttempts is 3, firstAttemptError still references the FIRST failure's code/message, not the second's", async () => {
  let callCount = 0;
  const firstError = new ProviderError("first failure", { code: PROVIDER_ERROR_CODES.RATE_LIMIT, retryable: true });
  const secondError = new ProviderError("second failure", { code: PROVIDER_ERROR_CODES.TIMEOUT, retryable: true });
  const provider = {
    analyze: async () => {
      callCount += 1;
      if (callCount === 1) throw firstError;
      if (callCount === 2) throw secondError;
      return JSON.stringify({ results: [goodItem()] });
    },
  };
  const { providerAttempts, firstAttemptError } = await runProviderAnalysis(provider, context, {
    sleep: noopSleep,
    maxAttempts: 3,
  });
  assert.equal(callCount, 3);
  assert.equal(providerAttempts, 3);
  assert.deepEqual(firstAttemptError, { code: firstError.code, message: "Provider rate limit exceeded", retryable: true });
  assert.notEqual(
    firstAttemptError.message,
    "Provider request timed out",
    "firstAttemptError must not be replaced by the second failure's code/message"
  );
});

test("runProviderAnalysis: firstAttemptError is a safe normalized summary - only code/message/retryable, never .cause, a stack, or any request/credential detail", async () => {
  const causeWithSecrets = new Error("underlying network error carrying request internals");
  const err = new ProviderError("Service Unavailable", {
    code: PROVIDER_ERROR_CODES.NETWORK,
    retryable: true,
    cause: causeWithSecrets,
  });
  const provider = providerFailingThenSucceeding(1, err, [goodItem()]);
  const { firstAttemptError } = await runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 });

  assert.deepEqual(Object.keys(firstAttemptError).sort(), ["code", "message", "retryable"]);
  assert.equal("cause" in firstAttemptError, false);
  assert.equal(JSON.stringify(firstAttemptError).includes("underlying network error"), false);
});

// --- Roadmap #18.3 hardening: allowlisted, provider-neutral persisted message ---
//
// summarizeProviderError()'s persisted `message` must never be derived from
// err.message/err.cause/a real provider's own error text - only from a
// fixed, allowlisted lookup keyed on the generic PROVIDER_ERROR_CODES value.
// This protects against a secret, internal URL, or SDK-specific detail that
// happens to sit anywhere in an underlying error's text (not just at a
// truncation boundary) ever reaching a persisted artifact.

test("summarizeProviderError: an arbitrary Error's sensitive-looking message, once normalized exactly as the real retry loop would, never survives into the safe summary", () => {
  // An arbitrary (non-ProviderError) throw always normalizes to
  // retryable=false (see normalizeProviderError()), so under the real
  // retry loop it can only ever be a TERMINAL failure - never a first
  // failure followed by a successful retry - which means it can never
  // actually reach a persisted report at all (see the dedicated
  // no-persistence-on-terminal-failure test below). This test proves the
  // narrower, structural claim directly at the summarization boundary
  // itself: even if such an error's normalized form were ever summarized,
  // its sensitive text still could not survive into the safe summary.
  const sensitiveErr = new Error("SECRET=https://internal.example/token=super-secret-value");
  const normalized = normalizeProviderError(sensitiveErr);
  const summary = summarizeProviderError(normalized);

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("super-secret-value"), false);
  assert.equal(serialized.includes("internal.example"), false);
  assert.equal(serialized.includes("SECRET="), false);
  assert.deepEqual(summary, { code: PROVIDER_ERROR_CODES.UNKNOWN, message: "Unknown provider error", retryable: false });
});

test("runProviderAnalysis: an arbitrary Error is always terminal (never retried), so it can never actually reach a persisted report in the first place - the safety net above is defense-in-depth, not the only protection", async () => {
  const sensitiveErr = new Error("SECRET=https://internal.example/token=super-secret-value");
  const provider = providerFailingThenSucceeding(99, sensitiveErr, [goodItem()]);
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(provider.calls, 1, "a non-retryable first failure must never be retried, so no later successful attempt - and no report - can ever occur");
});

test("runProviderAnalysis: a NETWORK-coded ProviderError carrying a sensitive-looking underlying message persists only the fixed safe NETWORK summary", async () => {
  const err = new ProviderError("request failed for https://internal.example?token=abc123", {
    code: PROVIDER_ERROR_CODES.NETWORK,
    retryable: true,
  });
  const provider = providerFailingThenSucceeding(1, err, [goodItem()]);
  const { providerAttempts, firstAttemptError } = await runProviderAnalysis(provider, context, {
    sleep: noopSleep,
    maxAttempts: 3,
  });

  assert.equal(providerAttempts, 2);
  assert.equal(firstAttemptError.code, PROVIDER_ERROR_CODES.NETWORK);
  assert.equal(firstAttemptError.retryable, true);
  assert.equal(firstAttemptError.message, "Provider network request failed");

  const serialized = JSON.stringify(firstAttemptError);
  assert.equal(serialized.includes("internal.example"), false);
  assert.equal(serialized.includes("abc123"), false);
  assert.equal(serialized.includes("request failed for"), false);
});

test("runProviderAnalysis: two different NETWORK raw messages produce the identical persisted safe message - proves persistence is classification-based, not text-based", async () => {
  const rawMessages = ["fetch failed", "request to internal-host failed"];
  const persistedMessages = [];

  for (const raw of rawMessages) {
    const err = new ProviderError(raw, { code: PROVIDER_ERROR_CODES.NETWORK, retryable: true });
    const provider = providerFailingThenSucceeding(1, err, [goodItem()]);
    const { firstAttemptError } = await runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 });
    persistedMessages.push(firstAttemptError.message);
  }

  assert.equal(persistedMessages[0], persistedMessages[1]);
  assert.equal(persistedMessages[0], "Provider network request failed");
});

test("summarizeProviderError: every PROVIDER_ERROR_CODES value maps to its fixed, provider-neutral message - table-driven", () => {
  const expected = {
    [PROVIDER_ERROR_CODES.AUTH]: "Provider authentication failed",
    [PROVIDER_ERROR_CODES.RATE_LIMIT]: "Provider rate limit exceeded",
    [PROVIDER_ERROR_CODES.TIMEOUT]: "Provider request timed out",
    [PROVIDER_ERROR_CODES.NETWORK]: "Provider network request failed",
    [PROVIDER_ERROR_CODES.INVALID_RESPONSE]: "Provider returned an invalid response",
    [PROVIDER_ERROR_CODES.CONFIGURATION]: "Provider configuration error",
    [PROVIDER_ERROR_CODES.UNKNOWN]: "Unknown provider error",
  };

  for (const code of Object.values(PROVIDER_ERROR_CODES)) {
    const err = new ProviderError("irrelevant - must never be persisted", { code, retryable: false });
    const summary = summarizeProviderError(err);
    assert.equal(summary.code, code);
    assert.equal(summary.message, expected[code], `unexpected safe message for code ${code}`);
    assert.equal(summary.message.includes("irrelevant"), false);
  }
});

test("summarizeProviderError: an unrecognized/missing code falls back to the fixed UNKNOWN message rather than ever reading err.message", () => {
  const err = new ProviderError("should never be persisted", { code: "NOT_A_REAL_CODE", retryable: false });
  assert.deepEqual(summarizeProviderError(err), { code: "NOT_A_REAL_CODE", message: "Unknown provider error", retryable: false });
});

test("runProviderAnalysis: a non-empty response containing malformed QA JSON still makes exactly one provider call - no semantic retry was added", async () => {
  let calls = 0;
  const provider = {
    analyze: async () => {
      calls += 1;
      return "this is not json at all";
    },
  };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep, maxAttempts: 3 }), /not valid JSON/);
  assert.equal(calls, 1, "malformed QA JSON must not trigger a retry - that behavior is intentionally out of scope for #18.3");
});

test("readHistory: returns null when reports/ai/history.json doesn't exist", (t) => {
  fs.rmSync(path.dirname(HISTORY_FILE), { recursive: true, force: true });
  t.after(() => fs.rmSync(path.dirname(HISTORY_FILE), { recursive: true, force: true }));

  assert.equal(readHistory(), null);
});

test("readHistory: returns null when history.json is marked unavailable", (t) => {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ available: false, reason: "no prior runs" }));
  t.after(() => fs.rmSync(path.dirname(HISTORY_FILE), { recursive: true, force: true }));

  assert.equal(readHistory(), null);
});

test("readHistory: returns null for unparseable JSON instead of throwing", (t) => {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, "{ not json");
  t.after(() => fs.rmSync(path.dirname(HISTORY_FILE), { recursive: true, force: true }));

  assert.doesNotThrow(() => readHistory());
  assert.equal(readHistory(), null);
});

test("readHistory: strips internal bookkeeping fields, keeping only the compact aggregate counts", (t) => {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify({
      available: true,
      browser: "chrome",
      branch: "main",
      runsConsidered: 10,
      passes: 7,
      failures: 3,
      retryPasses: 2,
      generatedAt: "2026-01-01T00:00:00.000Z",
    })
  );
  t.after(() => fs.rmSync(path.dirname(HISTORY_FILE), { recursive: true, force: true }));

  assert.deepEqual(readHistory(), { runsConsidered: 10, passes: 7, failures: 3, retryPasses: 2 });
});

// --- pipeline (contract-boundary integration) test ------------------------
// No network, no filesystem beyond what the test controls directly:
// `history: null` is passed explicitly so this never touches the real
// reports/ai/history.json (avoiding any interaction with the readHistory
// tests above, which do use that file). Exercises the real MockProvider -
// not a hand-rolled fake - through the real buildFailureReport(), the same
// function main() calls, so this is the closest thing to an end-to-end
// check of "fixture context -> MockProvider -> validated ai-report.json
// shape" this test suite has, while staying fully deterministic.
test("buildFailureReport: fixture context through the real MockProvider produces a valid, fully-populated report", async () => {
  const provider = new MockProvider();
  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: [] });

  assert.equal(report.results.length, 1);
  const [result] = report.results;
  assert.ok(CLASSIFICATIONS.includes(result.classification));
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.deepEqual(validateAnalysisItem(result, 0), []);

  assert.equal(report.analysis.provider, "mock");
  assert.ok(Date.parse(report.analysis.generatedAt), "analysis.generatedAt must be a valid ISO timestamp");
  assert.ok(Date.parse(report.generatedAt), "generatedAt must be a valid ISO timestamp");

  assert.equal(report.history, null);
  assert.deepEqual(report.warnings, []);
});

test("buildFailureReport: a provider without a .name still produces a report, falling back to 'unknown'", async () => {
  const provider = { analyze: async () => JSON.stringify({ results: [goodItem()] }) };
  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: [] });
  assert.equal(report.analysis.provider, "unknown");
});

// --- Roadmap #18.3: provider-attempt provenance on the persisted report ---
//
// LEVEL 2 (report plumbing) only: does runProviderAnalysis()'s
// providerAttempts/firstAttemptError land under report.analysis at all?
// LEVEL 1 (retry orchestration itself - attempt counting for 1/2/3
// attempts, first-error-only capture, safe-summary mapping) is already
// exhaustively covered above at the runProviderAnalysis level, with
// noopSleep, at zero real-time cost. buildFailureReport() has no way to
// inject a zero-delay sleep (it calls runProviderAnalysis(provider,
// context) with no options), so a buildFailureReport-level test that
// forces an actual retry would pay a real ~500ms backoff wait for
// coverage that already exists elsewhere at zero cost - not worth it,
// and production code is intentionally not changed just to avoid it. The
// single immediate-success case below is sufficient to prove the plumbing
// itself (a plain destructure-and-reassign with no attempt-count-dependent
// branching), together with policy/classification fields.
test("buildFailureReport: analysis.providerAttempts is 1 and analysis.firstAttemptError is null for a first-attempt-success report", async () => {
  const provider = new MockProvider();
  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: [] });
  assert.equal(report.analysis.providerAttempts, 1);
  assert.equal(report.analysis.firstAttemptError, null);
  assert.equal(report.results.length, 1);
  assert.ok(CLASSIFICATIONS.includes(report.results[0].classification));
});

// --- multi-browser correlation passthrough (PR #33) -------------------------

test("buildFailureReport: sourceContext.browserCorrelation is null when context has no correlation metadata", async () => {
  const provider = providerReturning([goodItem()]);
  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: [] });
  assert.equal(report.sourceContext.browserCorrelation, null);
});

test("buildFailureReport: sourceContext.browserCorrelation carries through unchanged when present on context (observability, not just prompt input)", async () => {
  const correlation = {
    browsers: ["chrome", "edge"],
    failedBrowsers: ["chrome", "edge"],
    passedBrowsers: [],
    primaryBrowser: "chrome",
    additionalFailedBrowsers: ["edge"],
    failureScope: "multi-browser",
    sameFailureSignature: true,
  };
  const provider = providerReturning([goodItem()]);
  const report = await buildFailureReport({ ...context, browserCorrelation: correlation }, { provider, history: null, relevantKnowledge: [] });
  assert.deepEqual(report.sourceContext.browserCorrelation, correlation);
});

// --- agent policy integration ----------------------------------------------
// Proves the full pipeline - provider -> parse -> validate -> agent policy
// -> report - actually applies scripts/ai/agent-policy.js, not just that
// the pure function exists in isolation (see agent-policy.test.js for that).

test("buildFailureReport: regression - TEST_BUG + shouldCreateBug=true from the provider is forced to false in the final report", async () => {
  const provider = providerReturning([goodItem({ classification: "TEST_BUG", shouldCreateBug: true })]);
  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: [] });

  const [result] = report.results;
  assert.equal(result.classification, "TEST_BUG");
  assert.equal(result.shouldCreateBug, false);
  assert.equal(result.policy.adjusted, true);
  assert.equal(result.policy.originalShouldCreateBug, true);
});

test("buildFailureReport: PRODUCT_BUG + shouldCreateBug=true from the provider is preserved in the final report", async () => {
  const provider = providerReturning([goodItem({ classification: "PRODUCT_BUG", shouldCreateBug: true })]);
  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: [] });

  const [result] = report.results;
  assert.equal(result.classification, "PRODUCT_BUG");
  assert.equal(result.shouldCreateBug, true);
  assert.equal(result.policy.adjusted, false);
  assert.equal(result.policy.originalShouldCreateBug, true);
});

test("buildFailureReport: policy is applied per-result, not just to the first item", async () => {
  const multiTestContext = {
    ...context,
    failedTests: [
      { ...context.failedTests[0], title: "product bug test" },
      { ...context.failedTests[0], title: "test bug test" },
    ],
  };
  const provider = providerReturning([
    goodItem({ test: { title: "product bug test", specFile: context.failedTests[0].specFile }, classification: "PRODUCT_BUG", shouldCreateBug: true }),
    goodItem({ test: { title: "test bug test", specFile: context.failedTests[0].specFile }, classification: "TEST_BUG", shouldCreateBug: true }),
  ]);

  const report = await buildFailureReport(multiTestContext, { provider, history: null, relevantKnowledge: [] });

  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].classification, "PRODUCT_BUG");
  assert.equal(report.results[0].shouldCreateBug, true);
  assert.equal(report.results[1].classification, "TEST_BUG");
  assert.equal(report.results[1].shouldCreateBug, false);
});

// --- QA Knowledge production integration (Roadmap #16A) --------------------
// computeRelevantKnowledge()/buildFailureReport()'s relevantKnowledge option
// wire scripts/ai/knowledge/'s (Roadmap #15) loader+selector into the real
// production analysis path. See qa-agent-prompt.test.js for the prompt's
// textual authority-contract tests; these prove the actual wiring.

function timeoutFailedTest() {
  return {
    title: "should select the Gastronomy category",
    specFile: "cypress/e2e/tests/select_group_POI.cy.js",
    error: { message: "Timed out retrying after 4000ms: expected cy.get('#mat-checkbox-3') to be checked", stack: null },
  };
}

// A. relevant knowledge selected from current-run context reaches the prompt.
test("Roadmap #16A A: relevant knowledge selected from current-run context reaches the production prompt", async () => {
  let captured;
  const provider = {
    analyze: async (args) => {
      captured = args;
      return JSON.stringify({ results: [goodItem({ test: { title: timeoutFailedTest().title, specFile: timeoutFailedTest().specFile } })] });
    },
  };
  const timeoutContext = { ...context, failedTests: [timeoutFailedTest()] };

  // No relevantKnowledge override - exercises the REAL loadKnowledgeUnits()
  // + selectKnowledge() default against the real production corpus.
  await buildFailureReport(timeoutContext, { provider, history: null });

  assert.match(captured.userPrompt, /"qa-timeout-error-multiple-causes"/);
  assert.match(captured.userPrompt, /A 'Timed out retrying' error can arise from several distinct mechanisms/);
});

// B. irrelevant knowledge does not reach the prompt.
// Note: Roadmap #16B identified that "framework-cypress-retry-timeout-
// semantics" previously carried a bare "cypress" tag that matched the
// selector's default framework marker (present in every real production
// context.json, which never sets context.frameworks) regardless of actual
// topical relevance - so that unit used to be selected for essentially
// every real production failure. Roadmap #16B.1 corrected this (see
// scripts/ai/knowledge/units/framework-cypress-retry-timeout-semantics.json
// and scripts/ai/knowledge/selector.test.js's "#16B.1" tests for the
// dedicated selector-level regression coverage) by removing that tag,
// leaving only genuinely topical retry/timeout tags. This test now
// verifies the corrected principle honestly: irrelevant framework
// retry/timeout knowledge is absent when the current failure contains no
// relevant retry/timeout evidence - all four production units are
// correctly excluded here, not just three.
test("Roadmap #16A B / #16B.1: units unrelated to the current failure (firefox/cross-browser/timeout/framework) are excluded from the real production prompt", async () => {
  const noMatchContext = {
    ...context,
    metadata: { ...context.metadata, browser: "chrome" },
    failedTests: [
      {
        title: "network call fails",
        specFile: "cypress/e2e/tests/poi_data_requests.cy.js",
        error: { message: "NetworkError: connection reset by peer", stack: null },
      },
    ],
  };
  let captured;
  const provider = {
    analyze: async (args) => {
      captured = args;
      return JSON.stringify({
        results: [goodItem({ test: { title: "network call fails", specFile: noMatchContext.failedTests[0].specFile } })],
      });
    },
  };

  const report = await buildFailureReport(noMatchContext, { provider, history: null });

  assert.doesNotMatch(captured.userPrompt, /"project-firefox-execution-environment-split"/);
  assert.doesNotMatch(captured.userPrompt, /"cross-browser-differing-signature-caution"/);
  assert.doesNotMatch(captured.userPrompt, /"qa-timeout-error-multiple-causes"/);
  assert.doesNotMatch(captured.userPrompt, /"framework-cypress-retry-timeout-semantics"/);
  assert.match(captured.userPrompt, /"relevantKnowledge": \[\]/);
  assert.equal(report.results.length, 1);
  assert.deepEqual(validateAnalysisItem(report.results[0], 0), []);
});

// C. zero-match selector result produces a valid prompt (Phase 10).
test("Roadmap #16A C / Phase 10: selectKnowledge() genuinely returning [] still produces a valid, unaffected report", async () => {
  // Proven at the true selector boundary (an empty units list, rather than
  // relying on every real curated unit happening to score 0, which
  // framework-cypress-retry-timeout-semantics never does in production -
  // see the note above) - this isolates "zero selected knowledge" from
  // "which specific units this corpus happens to contain".
  assert.deepEqual(selectKnowledge(context, []), []);

  const provider = providerReturning([goodItem()]);
  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: [] });

  assert.equal(report.results.length, 1);
  assert.deepEqual(validateAnalysisItem(report.results[0], 0), []);
  assert.equal(report.results[0].classification, "TEST_BUG");
});

// D. deterministic input -> byte-identical relevantKnowledge across repeated calls.
test("Roadmap #16A D: computeRelevantKnowledge is deterministic - same context produces deeply identical output across repeated calls", () => {
  const timeoutContext = { ...context, failedTests: [timeoutFailedTest()] };
  const first = computeRelevantKnowledge(timeoutContext);
  const second = computeRelevantKnowledge(timeoutContext);
  assert.deepEqual(first, second);
});

// E. maxUnits/maxChars budget remains respected through production wiring.
test("Roadmap #16A E: computeRelevantKnowledge uses the selector's real default budget (no override introduced by the wiring)", () => {
  // A context deliberately matching every real production unit's tags at
  // once (firefox browser, timeout error text, cypress framework marker,
  // multi-browser correlation) - even so, computeRelevantKnowledge must
  // still be bounded by selectKnowledge's own default maxUnits/maxChars,
  // not some looser limit introduced by the production wiring.
  const allMatchingContext = {
    ...context,
    metadata: { ...context.metadata, browser: "firefox" },
    failedTests: [timeoutFailedTest()],
    browserCorrelation: {
      browsers: ["chrome", "firefox"],
      failedBrowsers: ["chrome", "firefox"],
      passedBrowsers: [],
      primaryBrowser: "firefox",
      additionalFailedBrowsers: ["chrome"],
      failureScope: "multi-browser",
      sameFailureSignature: false,
    },
  };

  const viaWiring = computeRelevantKnowledge(allMatchingContext);
  const viaDirectSelectorCall = selectKnowledge(allMatchingContext, loadKnowledgeUnits());

  assert.deepEqual(viaWiring, viaDirectSelectorCall);
  assert.ok(viaWiring.length <= 5, "must never exceed selectKnowledge's default maxUnits");
  const totalChars = viaWiring.reduce((sum, k) => sum + k.statement.length, 0);
  assert.ok(totalChars <= 2000, "must never exceed selectKnowledge's default maxChars");
});

// F. selector runs before provider output exists.
test("Roadmap #16A F: knowledge selection is already complete by the time provider.analyze() is invoked (before any provider output exists)", async () => {
  let userPromptAtCallTime = null;
  const provider = {
    analyze: async (args) => {
      // Captured synchronously at call time, before this function returns
      // anything - if selection happened after the provider call instead
      // of before, relevantKnowledge could not already be present here.
      userPromptAtCallTime = args.userPrompt;
      return JSON.stringify({ results: [goodItem({ test: { title: timeoutFailedTest().title, specFile: timeoutFailedTest().specFile } })] });
    },
  };
  const timeoutContext = { ...context, failedTests: [timeoutFailedTest()] };

  await buildFailureReport(timeoutContext, { provider, history: null });

  assert.match(userPromptAtCallTime, /"qa-timeout-error-multiple-causes"/);
});

// G/H. knowledge integration adds zero provider calls; single logical
// analysis remains exactly one.
test("Roadmap #16A G/H: provider.analyze() is called exactly once, regardless of knowledge selection", async () => {
  let callCount = 0;
  const provider = {
    analyze: async () => {
      callCount += 1;
      return JSON.stringify({ results: [goodItem({ test: { title: timeoutFailedTest().title, specFile: timeoutFailedTest().specFile } })] });
    },
  };
  const timeoutContext = { ...context, failedTests: [timeoutFailedTest()] };

  await buildFailureReport(timeoutContext, { provider, history: null });

  assert.equal(callCount, 1);
});

// I. no per-browser knowledge-provider call is introduced.
test("Roadmap #16A I: computeRelevantKnowledge is a plain synchronous function with no provider dependency at all", () => {
  const timeoutContext = { ...context, failedTests: [timeoutFailedTest()] };
  const result = computeRelevantKnowledge(timeoutContext);
  // Synchronous return (not a Promise) is itself structural proof this
  // cannot be calling an async provider.analyze() - a provider call would
  // force this function to return a Promise.
  assert.equal(result instanceof Promise, false);
  assert.ok(Array.isArray(result));
  // computeRelevantKnowledge's own signature takes only a context - no
  // provider/browser-loop parameter exists for it to call per-browser.
  assert.equal(computeRelevantKnowledge.length, 1);
});

// CASE 7 (Phase 13) / J (Phase 12): knowledge cannot bypass application
// policy - a plausible-sounding knowledge statement must not change
// agent-policy.js's shouldCreateBug ceiling for a non-PRODUCT_BUG result.
test("Roadmap #16A CASE 7: knowledge suggesting a plausible bug does not bypass application policy - TEST_BUG + shouldCreateBug=true is still forced to false", async () => {
  const provider = providerReturning([goodItem({ classification: "TEST_BUG", shouldCreateBug: true })]);

  const report = await buildFailureReport(context, {
    provider,
    history: null,
    relevantKnowledge: [
      { id: "qa-timeout-error-multiple-causes", statement: "A timeout error can indicate several distinct mechanisms, including product-side issues." },
    ],
  });

  const [result] = report.results;
  assert.equal(result.classification, "TEST_BUG");
  assert.equal(result.shouldCreateBug, false);
  assert.equal(result.policy.adjusted, true);
  assert.equal(result.policy.originalShouldCreateBug, true);
});

// --- Knowledge observability (Roadmap #16C) --------------------------------
// The exact knowledge units the provider actually received must be
// recoverable from the frozen artifact (ai-report.json's sourceContext),
// not only reconstructible by re-running the selector against the corpus
// as it exists today (which could have drifted since the report was
// generated). pickSourceContext() reads context.relevantKnowledge directly
// - the same value already threaded into the prompt - rather than calling
// selectKnowledge() a second time.

test("Roadmap #16C 1/2: selected knowledge appears in report.sourceContext.relevantKnowledge, with exact ids/statements matching what the provider prompt received", async () => {
  const timeoutContext = { ...context, failedTests: [timeoutFailedTest()] };
  let captured;
  const provider = {
    analyze: async (args) => {
      captured = args;
      return JSON.stringify({ results: [goodItem({ test: { title: timeoutFailedTest().title, specFile: timeoutFailedTest().specFile } })] });
    },
  };

  const report = await buildFailureReport(timeoutContext, { provider, history: null });

  assert.ok(Array.isArray(report.sourceContext.relevantKnowledge));
  assert.ok(report.sourceContext.relevantKnowledge.length > 0);

  const promptPayload = JSON.parse(captured.userPrompt.slice(captured.userPrompt.indexOf("{"), captured.userPrompt.lastIndexOf("}") + 1));
  assert.deepEqual(report.sourceContext.relevantKnowledge, promptPayload.relevantKnowledge);
});

test("Roadmap #16C 3: zero selected knowledge persists as sourceContext.relevantKnowledge = [], not omitted", async () => {
  const provider = providerReturning([goodItem()]);
  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: [] });
  assert.deepEqual(report.sourceContext.relevantKnowledge, []);
  assert.ok("relevantKnowledge" in report.sourceContext);
});

test("Roadmap #16C 4: relevantKnowledge is not regenerated after provider analysis - sourceContext reflects the exact value supplied, not a fresh selectKnowledge() call", async () => {
  // Deliberately inject knowledge that the real selector would NOT compute
  // for this context (context has no timeout-shaped error at all) - if
  // pickSourceContext() were re-running selection instead of reading
  // context.relevantKnowledge, this injected value would be silently
  // replaced with [] (or whatever the real selector produces).
  const injectedKnowledge = [{ id: "synthetic-test-only-unit", statement: "A statement that the real selector would never produce for this context." }];
  const provider = providerReturning([goodItem()]);

  const report = await buildFailureReport(context, { provider, history: null, relevantKnowledge: injectedKnowledge });

  assert.deepEqual(report.sourceContext.relevantKnowledge, injectedKnowledge);
  // Sanity check: the real selector genuinely would not have produced this
  // for the unmodified `context` fixture (no timeout/retry/firefox/
  // correlation signal present).
  const realSelection = selectKnowledge(context, loadKnowledgeUnits());
  assert.notDeepEqual(realSelection, injectedKnowledge);
});

test("Roadmap #16C 5: persisting relevantKnowledge into sourceContext adds zero provider calls", async () => {
  let callCount = 0;
  const provider = {
    analyze: async () => {
      callCount += 1;
      return JSON.stringify({ results: [goodItem({ test: { title: timeoutFailedTest().title, specFile: timeoutFailedTest().specFile } })] });
    },
  };
  const timeoutContext = { ...context, failedTests: [timeoutFailedTest()] };

  const report = await buildFailureReport(timeoutContext, { provider, history: null });

  assert.equal(callCount, 1);
  assert.ok(report.sourceContext.relevantKnowledge.length > 0);
});

test("Roadmap #16C 6: sourceContext observability does not affect classification/policy behavior", async () => {
  const provider = providerReturning([goodItem({ classification: "TEST_BUG", shouldCreateBug: true })]);
  const report = await buildFailureReport(context, {
    provider,
    history: null,
    relevantKnowledge: [{ id: "qa-timeout-error-multiple-causes", statement: "A timeout error can indicate several distinct mechanisms." }],
  });

  // Same policy outcome as the equivalent pre-#16C regression test - adding
  // sourceContext.relevantKnowledge changes nothing about the classify ->
  // validate -> policy pipeline.
  assert.equal(report.results[0].classification, "TEST_BUG");
  assert.equal(report.results[0].shouldCreateBug, false);
  assert.equal(report.results[0].policy.adjusted, true);
});

test("Roadmap #16C 7: existing sourceContext fields (browserCorrelation, browser, commit, etc.) remain unchanged alongside the new relevantKnowledge field", async () => {
  const correlation = {
    browsers: ["chrome", "edge"],
    failedBrowsers: ["chrome", "edge"],
    passedBrowsers: [],
    primaryBrowser: "chrome",
    additionalFailedBrowsers: ["edge"],
    failureScope: "multi-browser",
    sameFailureSignature: true,
  };
  const provider = providerReturning([goodItem()]);
  const report = await buildFailureReport(
    { ...context, browserCorrelation: correlation },
    { provider, history: null, relevantKnowledge: [] }
  );

  assert.deepEqual(report.sourceContext.browserCorrelation, correlation);
  assert.equal(report.sourceContext.repository, "o/r");
  assert.equal(report.sourceContext.commit, "abc123");
  assert.equal(report.sourceContext.branch, "main");
  assert.equal(report.sourceContext.browser, "chrome");
  assert.equal(report.sourceContext.projectId, null, "context fixture above carries no metadata.projectId");
  assert.deepEqual(report.sourceContext.relevantKnowledge, []);
});

// Roadmap #19.2 - explicit project identity foundation. projectId is
// read straight from context.metadata.projectId (set by
// collect-context.js in production) - these tests prove the pass-through
// is exact and additive, and that adding it changed nothing else about
// provider selection, provider provenance, or policy shape.
test("Roadmap #19.2: sourceContext.projectId equals the production project id when context.metadata carries it", async () => {
  const provider = providerReturning([goodItem()]);
  const report = await buildFailureReport(
    { ...context, metadata: { ...context.metadata, projectId: "targomo-poi" } },
    { provider, history: null, relevantKnowledge: [] }
  );

  assert.equal(report.sourceContext.projectId, "targomo-poi");
});

test("Roadmap #19.2: projectId is additive only - provider provenance and policy field shape are unchanged", async () => {
  const provider = providerReturning([goodItem({ shouldCreateBug: true })]);
  const report = await buildFailureReport(
    { ...context, metadata: { ...context.metadata, projectId: "targomo-poi" } },
    { provider, history: null, relevantKnowledge: [] }
  );

  assert.equal(report.analysis.provider, "unknown");
  assert.equal(report.analysis.providerAttempts, 1);
  assert.equal(report.analysis.firstAttemptError, null);
  // goodItem() defaults to classification: "TEST_BUG", so policy must
  // still force shouldCreateBug to false regardless of projectId.
  assert.equal(report.results[0].shouldCreateBug, false);
  assert.equal(report.results[0].policy.adjusted, true);
  assert.equal(report.results[0].policy.originalShouldCreateBug, true);
});

// Phase 10: prompt/report consistency - the knowledge visible in the real
// provider prompt for a given analysis must correspond exactly to what
// gets frozen into sourceContext for that same analysis, so a future
// reader of the frozen report can reconstruct "what did the model see"
// without needing the raw prompt text at all.
test("Roadmap #16C Phase 10: prompt-visible relevantKnowledge and report.sourceContext.relevantKnowledge are exactly consistent for the same analysis", async () => {
  const allMatchingContext = {
    ...context,
    metadata: { ...context.metadata, browser: "firefox" },
    failedTests: [timeoutFailedTest()],
    browserCorrelation: {
      browsers: ["chrome", "firefox"],
      failedBrowsers: ["chrome", "firefox"],
      passedBrowsers: [],
      primaryBrowser: "firefox",
      additionalFailedBrowsers: ["chrome"],
      failureScope: "multi-browser",
      sameFailureSignature: false,
    },
  };
  let captured;
  const provider = {
    analyze: async (args) => {
      captured = args;
      return JSON.stringify({ results: [goodItem({ test: { title: timeoutFailedTest().title, specFile: timeoutFailedTest().specFile } })] });
    },
  };

  const report = await buildFailureReport(allMatchingContext, { provider, history: null });

  const promptPayload = JSON.parse(captured.userPrompt.slice(captured.userPrompt.indexOf("{"), captured.userPrompt.lastIndexOf("}") + 1));
  assert.ok(promptPayload.relevantKnowledge.length > 1, "expected multiple units to genuinely match this multi-signal context");
  assert.deepEqual(report.sourceContext.relevantKnowledge, promptPayload.relevantKnowledge);
});
