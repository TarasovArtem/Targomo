"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MockProvider } = require("./mock-provider");
const { CLASSIFICATIONS } = require("../qa-agent-prompt");
const { validateAnalysisItem } = require("../analyze-failure");

function userPromptFor(failedTests) {
  return ["Analyze the following.", "", "```json", JSON.stringify({ failedTests }, null, 2), "```"].join("\n");
}

test("MockProvider.analyze: performs no network request", async (t) => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("MockProvider must never call fetch");
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const provider = new MockProvider();
  await provider.analyze({ systemPrompt: "sys", userPrompt: userPromptFor([{ title: "t", specFile: "s.cy.js" }]) });

  assert.equal(fetchCalled, false);
});

test("MockProvider.analyze: returns a string", async () => {
  const provider = new MockProvider();
  const response = await provider.analyze({ systemPrompt: "sys", userPrompt: userPromptFor([{ title: "t" }]) });
  assert.equal(typeof response, "string");
});

test("MockProvider.analyze: the string is valid JSON", async () => {
  const provider = new MockProvider();
  const response = await provider.analyze({ systemPrompt: "sys", userPrompt: userPromptFor([{ title: "t" }]) });
  assert.doesNotThrow(() => JSON.parse(response));
});

test("MockProvider.analyze: result is compatible with the QA Agent schema and passes the real validator", async () => {
  const provider = new MockProvider();
  const raw = await provider.analyze({
    systemPrompt: "sys",
    userPrompt: userPromptFor([{ title: "example test", specFile: "cypress/e2e/tests/example.cy.js" }]),
  });
  const parsed = JSON.parse(raw);

  assert.ok(Array.isArray(parsed.results));
  assert.equal(parsed.results.length, 1);

  const [result] = parsed.results;
  assert.equal(result.test.title, "example test");
  assert.ok(CLASSIFICATIONS.includes(result.classification), "classification must be an allowed enum value");
  assert.equal(typeof result.confidence, "number");
  assert.ok(result.confidence >= 0 && result.confidence <= 1);

  assert.deepEqual(validateAnalysisItem(result, 0), []);
});

test("MockProvider.analyze: produces one result per failed test, matching titles in order", async () => {
  const provider = new MockProvider();
  const raw = await provider.analyze({
    systemPrompt: "sys",
    userPrompt: userPromptFor([
      { title: "test one", specFile: "a.cy.js" },
      { title: "test two", specFile: "b.cy.js" },
    ]),
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0].test.title, "test one");
  assert.equal(parsed.results[1].test.title, "test two");
});

test("MockProvider.analyze: falls back to a single generic result when the prompt has no parseable failedTests", async () => {
  const provider = new MockProvider();
  const raw = await provider.analyze({ systemPrompt: "sys", userPrompt: "no json fence here at all" });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.results.length, 1);
  assert.equal(typeof parsed.results[0].test.title, "string");
  assert.deepEqual(validateAnalysisItem(parsed.results[0], 0), []);
});

test("MockProvider.analyze: is honest that no real analysis happened (visible in rootCause/summary, no fabricated evidence)", async () => {
  const provider = new MockProvider();
  const raw = await provider.analyze({ systemPrompt: "sys", userPrompt: userPromptFor([{ title: "t" }]) });
  const [result] = JSON.parse(raw).results;

  assert.match(result.rootCause, /no real ai provider/i);
  assert.deepEqual(result.evidence, ["Analysis was produced by MockProvider."]);
  assert.equal(result.shouldCreateBug, false);
  assert.equal(result.shouldRetry, false);
});
