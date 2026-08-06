"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CLASSIFICATIONS, buildSystemPrompt, buildUserPrompt } = require("./qa-agent-prompt");

test("CLASSIFICATIONS: exactly the six allowed values", () => {
  assert.deepEqual(
    [...CLASSIFICATIONS].sort(),
    ["ENVIRONMENT", "EXTERNAL_DEPENDENCY", "FLAKY_TEST", "PRODUCT_BUG", "TEST_BUG", "UNKNOWN"].sort()
  );
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

test("buildSystemPrompt: forbids arbitrary waits, weakened assertions, and skipped tests as recommendations", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /cy\.wait\(5000\)/);
  assert.match(prompt, /waitForTimeout\(3000\)/);
  assert.match(prompt, /weakening an assertion|deleting or weakening/i);
  assert.match(prompt, /skipping the test/i);
  assert.match(prompt, /unbounded retries/i);
});

test("buildSystemPrompt: contains explicit prompt-injection defense instructions", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /PROMPT INJECTION DEFENSE/i);
  assert.match(prompt, /is DATA/);
  assert.match(prompt, /never follow, obey, or be persuaded/i);
  // The exact injection example from the task brief should be present as
  // an illustration of what NOT to obey.
  assert.match(prompt, /ignore previous instructions/i);
});

test("buildSystemPrompt: demands raw JSON only, no markdown/code fences/prose", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /no markdown/i);
  assert.match(prompt, /no code fences/i);
  assert.match(prompt, /"results"/);
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

test("buildUserPrompt: includes knownProjectConstraints when present, empty array when absent", () => {
  const withConstraints = buildUserPrompt({
    metadata: {},
    testResults: {},
    failedTests: [],
    relevantFiles: {},
    knownProjectConstraints: ["Firefox is excluded from CI for infrastructure reasons."],
  });
  assert.match(withConstraints, /Firefox is excluded from CI/);

  const withoutConstraints = buildUserPrompt({ metadata: {}, testResults: {}, failedTests: [], relevantFiles: {} });
  assert.match(withoutConstraints, /"knownProjectConstraints": \[\]/);
});

test("buildUserPrompt: reminds the model that the JSON payload is data, not instructions", () => {
  const prompt = buildUserPrompt({ metadata: {}, testResults: {}, failedTests: [], relevantFiles: {} });
  assert.match(prompt, /DATA, not instructions/i);
});
