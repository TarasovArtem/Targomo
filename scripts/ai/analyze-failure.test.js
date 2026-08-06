"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { callOpenAI, validateAnalysisItem, recommendsArbitraryWait, isRetryableError } = require("./analyze-failure");

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

function fakeClientReturning(resultsPayload, usage) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify({ results: resultsPayload }) } }],
          usage: usage || { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        }),
      },
    },
  };
}

const noopSleep = async () => {};

test("callOpenAI: happy path returns results that pass validation", async () => {
  const { results } = await callOpenAI("fake-key", context, { client: fakeClientReturning([goodItem()]) });
  assert.equal(results.length, 1);
  assert.deepEqual(validateAnalysisItem(results[0], 0), []);
  assert.equal(recommendsArbitraryWait(results[0]), false);
});

test("callOpenAI: result count mismatch is left for the caller to detect", async () => {
  const { results } = await callOpenAI("fake-key", context, { client: fakeClientReturning([goodItem(), goodItem()]) });
  assert.notEqual(results.length, context.failedTests.length);
});

test("validateAnalysisItem: rejects an invalid classification enum value", async () => {
  const { results } = await callOpenAI("fake-key", context, {
    client: fakeClientReturning([goodItem({ classification: "TOTALLY_MADE_UP" })]),
  });
  const errors = validateAnalysisItem(results[0], 0);
  assert.ok(errors.some((e) => e.includes("classification")));
});

test("validateAnalysisItem: rejects out-of-range confidence", async () => {
  const { results } = await callOpenAI("fake-key", context, { client: fakeClientReturning([goodItem({ confidence: 1.5 })]) });
  const errors = validateAnalysisItem(results[0], 0);
  assert.ok(errors.some((e) => e.includes("confidence")));
});

test("recommendsArbitraryWait: flags a fixed-duration wait recommendation", async () => {
  const { results } = await callOpenAI("fake-key", context, {
    client: fakeClientReturning([
      goodItem({ recommendedFix: { file: context.failedTests[0].specFile, description: "Just add cy.wait(5000) after the click." } }),
    ]),
  });
  assert.equal(recommendsArbitraryWait(results[0]), true);
});

test("recommendsArbitraryWait: does not flag a deterministic-sync recommendation", () => {
  assert.equal(recommendsArbitraryWait(goodItem()), false);
});

test("callOpenAI: a non-retryable API error (401) surfaces cleanly without leaking the raw key", async () => {
  // Mirrors what the real OpenAI API actually returns (verified live in an
  // earlier session): a masked key, never the unmasked value. This test
  // checks our code doesn't independently echo the *full* key anywhere -
  // not that the SDK's own masked echo is absent, which would be unrealistic.
  const realApiKey = "sk-REALSECRETVALUE1234567890";
  const client = {
    chat: {
      completions: {
        create: async () => {
          const err = new Error("401 Incorrect API key provided: sk-REAL***************7890.");
          err.status = 401;
          throw err;
        },
      },
    },
  };
  await assert.rejects(
    () => callOpenAI(realApiKey, context, { client, sleep: noopSleep }),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, new RegExp(realApiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    }
  );
});

test("isRetryableError: classifies status codes correctly", () => {
  assert.equal(isRetryableError({ status: 429 }), true);
  assert.equal(isRetryableError({ status: 500 }), true);
  assert.equal(isRetryableError({ status: 503 }), true);
  assert.equal(isRetryableError({ status: 401 }), false);
  assert.equal(isRetryableError({ status: 400 }), false);
  assert.equal(isRetryableError({ message: "network error, no status" }), true);
});

test("callOpenAI: retries a transient 503 and succeeds on a later attempt", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          if (calls < 3) {
            const err = new Error("Service unavailable");
            err.status = 503;
            throw err;
          }
          return fakeClientReturning([goodItem()]).chat.completions.create();
        },
      },
    },
  };

  const { results } = await callOpenAI("fake-key", context, { client, sleep: noopSleep, maxAttempts: 3 });
  assert.equal(calls, 3, "should have retried twice before succeeding on the third attempt");
  assert.equal(results.length, 1);
});

test("callOpenAI: never retries a 401 - fails on the first attempt", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          const err = new Error("bad key");
          err.status = 401;
          throw err;
        },
      },
    },
  };

  await assert.rejects(() => callOpenAI("fake-key", context, { client, sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(calls, 1, "a 401 should never be retried");
});

test("callOpenAI: gives up after maxAttempts on persistent transient errors", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          const err = new Error("Service unavailable");
          err.status = 503;
          throw err;
        },
      },
    },
  };

  await assert.rejects(() => callOpenAI("fake-key", context, { client, sleep: noopSleep, maxAttempts: 3 }));
  assert.equal(calls, 3);
});
