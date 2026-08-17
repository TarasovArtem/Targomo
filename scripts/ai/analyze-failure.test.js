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
  readHistory,
} = require("./analyze-failure");
const { ProviderError, PROVIDER_ERROR_CODES } = require("./providers/provider-error");
const { MockProvider } = require("./providers/mock-provider");
const { CLASSIFICATIONS } = require("./qa-agent-prompt");

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
  const report = await buildFailureReport(context, { provider, history: null });

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
  const report = await buildFailureReport(context, { provider, history: null });
  assert.equal(report.analysis.provider, "unknown");
});

// --- multi-browser correlation passthrough (PR #33) -------------------------

test("buildFailureReport: sourceContext.browserCorrelation is null when context has no correlation metadata", async () => {
  const provider = providerReturning([goodItem()]);
  const report = await buildFailureReport(context, { provider, history: null });
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
  const report = await buildFailureReport({ ...context, browserCorrelation: correlation }, { provider, history: null });
  assert.deepEqual(report.sourceContext.browserCorrelation, correlation);
});

// --- agent policy integration ----------------------------------------------
// Proves the full pipeline - provider -> parse -> validate -> agent policy
// -> report - actually applies scripts/ai/agent-policy.js, not just that
// the pure function exists in isolation (see agent-policy.test.js for that).

test("buildFailureReport: regression - TEST_BUG + shouldCreateBug=true from the provider is forced to false in the final report", async () => {
  const provider = providerReturning([goodItem({ classification: "TEST_BUG", shouldCreateBug: true })]);
  const report = await buildFailureReport(context, { provider, history: null });

  const [result] = report.results;
  assert.equal(result.classification, "TEST_BUG");
  assert.equal(result.shouldCreateBug, false);
  assert.equal(result.policy.adjusted, true);
  assert.equal(result.policy.originalShouldCreateBug, true);
});

test("buildFailureReport: PRODUCT_BUG + shouldCreateBug=true from the provider is preserved in the final report", async () => {
  const provider = providerReturning([goodItem({ classification: "PRODUCT_BUG", shouldCreateBug: true })]);
  const report = await buildFailureReport(context, { provider, history: null });

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

  const report = await buildFailureReport(multiTestContext, { provider, history: null });

  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].classification, "PRODUCT_BUG");
  assert.equal(report.results[0].shouldCreateBug, true);
  assert.equal(report.results[1].classification, "TEST_BUG");
  assert.equal(report.results[1].shouldCreateBug, false);
});
