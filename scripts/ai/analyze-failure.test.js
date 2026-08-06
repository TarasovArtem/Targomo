"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  callGitHubModels,
  validateAnalysisItem,
  recommendsArbitraryWait,
  isRetryableStatus,
  stripCodeFences,
  readHistory,
} = require("./analyze-failure");

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

// Fakes global fetch's Response shape just enough for callGitHubModels.
function fakeResponse({ ok = true, status = 200, statusText = "OK", body }) {
  return { ok, status, statusText, json: async () => body };
}

function fetchReturning(resultsPayload, usage) {
  return async () =>
    fakeResponse({
      body: {
        choices: [{ message: { content: JSON.stringify({ results: resultsPayload }) } }],
        usage: usage || { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      },
    });
}

const noopSleep = async () => {};

test("callGitHubModels: happy path returns results that pass validation", async () => {
  const { results } = await callGitHubModels("fake-token", context, { fetchImpl: fetchReturning([goodItem()]) });
  assert.equal(results.length, 1);
  assert.deepEqual(validateAnalysisItem(results[0], 0), []);
  assert.equal(recommendsArbitraryWait(results[0]), false);
});

test("callGitHubModels: sends the token as a Bearer Authorization header, never elsewhere", async () => {
  let capturedHeaders;
  const fetchImpl = async (url, init) => {
    capturedHeaders = init.headers;
    return fakeResponse({ body: { choices: [{ message: { content: JSON.stringify({ results: [goodItem()] }) } }] } });
  };
  await callGitHubModels("my-token-value", context, { fetchImpl });
  assert.equal(capturedHeaders.Authorization, "Bearer my-token-value");
});

test("callGitHubModels: posts to the official GitHub Models inference endpoint", async () => {
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return fakeResponse({ body: { choices: [{ message: { content: JSON.stringify({ results: [goodItem()] }) } }] } });
  };
  await callGitHubModels("t", context, { fetchImpl });
  assert.equal(capturedUrl, "https://models.github.ai/inference/chat/completions");
});

test("callGitHubModels: strips a markdown code fence around the JSON if the model added one anyway", async () => {
  const fetchImpl = async () =>
    fakeResponse({
      body: { choices: [{ message: { content: "```json\n" + JSON.stringify({ results: [goodItem()] }) + "\n```" } }] },
    });
  const { results } = await callGitHubModels("t", context, { fetchImpl });
  assert.equal(results.length, 1);
});

test("callGitHubModels: result count mismatch is left for the caller to detect", async () => {
  const { results } = await callGitHubModels("t", context, { fetchImpl: fetchReturning([goodItem(), goodItem()]) });
  assert.notEqual(results.length, context.failedTests.length);
});

test("validateAnalysisItem: rejects an invalid classification enum value", async () => {
  const { results } = await callGitHubModels("t", context, {
    fetchImpl: fetchReturning([goodItem({ classification: "TOTALLY_MADE_UP" })]),
  });
  const errors = validateAnalysisItem(results[0], 0);
  assert.ok(errors.some((e) => e.includes("classification")));
});

test("validateAnalysisItem: rejects out-of-range confidence", async () => {
  const { results } = await callGitHubModels("t", context, { fetchImpl: fetchReturning([goodItem({ confidence: 1.5 })]) });
  const errors = validateAnalysisItem(results[0], 0);
  assert.ok(errors.some((e) => e.includes("confidence")));
});

test("recommendsArbitraryWait: flags a fixed-duration wait recommendation", async () => {
  const { results } = await callGitHubModels("t", context, {
    fetchImpl: fetchReturning([
      goodItem({ recommendedFix: { file: context.failedTests[0].specFile, description: "Just add cy.wait(5000) after the click." } }),
    ]),
  });
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

test("callGitHubModels: a non-retryable API error (401) surfaces cleanly without leaking the raw token", async () => {
  const realToken = "ghs_REALSECRETVALUE1234567890";
  const fetchImpl = async () => fakeResponse({ ok: false, status: 401, statusText: "Unauthorized" });

  await assert.rejects(
    () => callGitHubModels(realToken, context, { fetchImpl, sleep: noopSleep }),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, new RegExp(realToken));
      return true;
    }
  );
});

test("callGitHubModels: a 403 is treated the same as 401 - not retried, clean message", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse({ ok: false, status: 403, statusText: "Forbidden" });
  };
  await assert.rejects(() => callGitHubModels("t", context, { fetchImpl, sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(calls, 1);
});

test("callGitHubModels: a 429 error message explicitly names the GitHub Models rate limit", async () => {
  const fetchImpl = async () => fakeResponse({ ok: false, status: 429, statusText: "Too Many Requests" });
  await assert.rejects(
    () => callGitHubModels("t", context, { fetchImpl, sleep: noopSleep, maxAttempts: 1 }),
    (err) => {
      assert.match(err.message, /rate limit/i);
      return true;
    }
  );
});

test("isRetryableStatus: 429 and 5xx are retryable, 4xx auth/lookup errors are not", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(400), false);
});

test("callGitHubModels: retries a transient 503 and succeeds on a later attempt", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return fakeResponse({ ok: false, status: 503, statusText: "Service Unavailable" });
    return fakeResponse({ body: { choices: [{ message: { content: JSON.stringify({ results: [goodItem()] }) } }] } });
  };

  const { results } = await callGitHubModels("t", context, { fetchImpl, sleep: noopSleep, maxAttempts: 3 });
  assert.equal(calls, 3, "should have retried twice before succeeding on the third attempt");
  assert.equal(results.length, 1);
});

test("callGitHubModels: never retries a 401 - fails on the first attempt", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse({ ok: false, status: 401, statusText: "Unauthorized" });
  };

  await assert.rejects(() => callGitHubModels("t", context, { fetchImpl, sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(calls, 1, "a 401 should never be retried");
});

test("callGitHubModels: gives up after maxAttempts on persistent transient errors", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse({ ok: false, status: 500, statusText: "Internal Server Error" });
  };

  await assert.rejects(() => callGitHubModels("t", context, { fetchImpl, sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(calls, 3);
});

test("callGitHubModels: a network-level failure (no HTTP response at all) is retried like a transient error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 2) throw new Error("fetch failed: ECONNRESET");
    return fakeResponse({ body: { choices: [{ message: { content: JSON.stringify({ results: [goodItem()] }) } }] } });
  };
  const { results } = await callGitHubModels("t", context, { fetchImpl, sleep: noopSleep, maxAttempts: 3 });
  assert.equal(calls, 2);
  assert.equal(results.length, 1);
});

test("callGitHubModels: empty response content produces a clear error, not a crash", async () => {
  const fetchImpl = async () => fakeResponse({ body: { choices: [{ message: { content: "" } }] } });
  await assert.rejects(() => callGitHubModels("t", context, { fetchImpl, sleep: noopSleep }), /did not include any content/);
});

test("callGitHubModels: unexpected response structure (no choices at all) produces a clear error", async () => {
  const fetchImpl = async () => fakeResponse({ body: { unexpected: true } });
  await assert.rejects(() => callGitHubModels("t", context, { fetchImpl, sleep: noopSleep }), /did not include any content/);
});

test("callGitHubModels: invalid JSON in the response content produces a clear error, not a fabricated analysis", async () => {
  const fetchImpl = async () => fakeResponse({ body: { choices: [{ message: { content: "this is not json at all" } }] } });
  await assert.rejects(() => callGitHubModels("t", context, { fetchImpl, sleep: noopSleep }), /not valid JSON/);
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
