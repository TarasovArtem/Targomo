"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  runProviderAnalysis,
  validateAnalysisItem,
  recommendsArbitraryWait,
  stripCodeFences,
  readHistory,
} = require("./analyze-failure");
const { ProviderError } = require("./providers/provider-error");

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
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep }), /did not include any content/);
});

test("runProviderAnalysis: a non-string response produces a clear error, not a crash", async () => {
  const provider = { analyze: async () => null };
  await assert.rejects(() => runProviderAnalysis(provider, context, { sleep: noopSleep }), /did not include any content/);
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
