"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CLASSIFICATIONS, buildSystemPrompt, buildUserPrompt, RESPONSE_SCHEMA } = require("./qa-agent-prompt");

test("CLASSIFICATIONS: exactly the six allowed values", () => {
  assert.deepEqual(
    [...CLASSIFICATIONS].sort(),
    ["ENVIRONMENT", "EXTERNAL_DEPENDENCY", "FLAKY_TEST", "PRODUCT_BUG", "TEST_BUG", "UNKNOWN"].sort()
  );
});

test("RESPONSE_SCHEMA: classification enum matches CLASSIFICATIONS exactly", () => {
  const enumInSchema = RESPONSE_SCHEMA.properties.results.items.properties.classification.enum;
  assert.deepEqual(enumInSchema, CLASSIFICATIONS);
});

test("buildSystemPrompt: instructs the model not to treat a single failure as proof of FLAKY_TEST", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /FLAKY_TEST/);
  assert.match(prompt, /single failure/i);
  assert.match(prompt, /history/i);
});

test("buildSystemPrompt: still forbids treating a failure alone as PRODUCT_BUG proof (unchanged by this stage)", () => {
  assert.match(buildSystemPrompt(), /never, by itself, evidence of PRODUCT_BUG/);
});

test("buildUserPrompt: includes the compact history object when present on context", () => {
  const context = {
    metadata: {},
    testResults: {},
    failedTests: [],
    relevantFiles: {},
    history: { runsConsidered: 10, passes: 7, failures: 3, retryPasses: 2 },
  };
  const prompt = buildUserPrompt(context);
  assert.match(prompt, /"runsConsidered": 10/);
  assert.match(prompt, /"passes": 7/);
  assert.match(prompt, /"retryPasses": 2/);
});

test("buildUserPrompt: history is explicitly null when absent from context, not just omitted", () => {
  const context = { metadata: {}, testResults: {}, failedTests: [], relevantFiles: {} };
  const prompt = buildUserPrompt(context);
  assert.match(prompt, /"history": null/);
});

test("buildUserPrompt: never inlines the raw list of historical runs, only aggregated counts", () => {
  const context = {
    metadata: {},
    testResults: {},
    failedTests: [],
    relevantFiles: {},
    history: { runsConsidered: 10, passes: 7, failures: 3, retryPasses: 2 },
  };
  const prompt = buildUserPrompt(context);
  // The compact schema has exactly these four keys - nothing resembling a
  // per-run array (e.g. a "runs": [...] key) should ever appear.
  assert.doesNotMatch(prompt, /"runs"\s*:\s*\[/);
});
