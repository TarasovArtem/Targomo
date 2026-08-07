"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyAgentPolicy } = require("./agent-policy");

function baseResult(overrides = {}) {
  return {
    test: { title: "should do the thing", specFile: "cypress/e2e/tests/example.cy.js" },
    classification: "TEST_BUG",
    confidence: 0.9,
    summary: "Summary.",
    rootCause: "Root cause.",
    evidence: ["evidence"],
    recommendedFix: { file: null, description: "Fix it." },
    shouldCreateBug: false,
    shouldRetry: false,
    ...overrides,
  };
}

// --- the historical regression case --------------------------------------
// The exact failure mode observed during the first real Groq controlled
// experiment: classification=TEST_BUG, shouldCreateBug=true. Only
// PRODUCT_BUG may keep shouldCreateBug=true - this must never happen for
// a test bug, regardless of what the model recommended.

test("regression: TEST_BUG + shouldCreateBug=true is forced to false, and the override is recorded", () => {
  const result = applyAgentPolicy(baseResult({ classification: "TEST_BUG", shouldCreateBug: true }));
  assert.equal(result.shouldCreateBug, false);
  assert.equal(result.policy.adjusted, true);
  assert.equal(result.policy.originalShouldCreateBug, true);
});

// --- PRODUCT_BUG: the only classification that may keep shouldCreateBug=true ---

test("PRODUCT_BUG + true: preserved as true, not adjusted", () => {
  const result = applyAgentPolicy(baseResult({ classification: "PRODUCT_BUG", shouldCreateBug: true }));
  assert.equal(result.shouldCreateBug, true);
  assert.equal(result.policy.adjusted, false);
  assert.equal(result.policy.originalShouldCreateBug, true);
});

test("PRODUCT_BUG + false: preserved as false, not adjusted (policy never forces PRODUCT_BUG to true)", () => {
  const result = applyAgentPolicy(baseResult({ classification: "PRODUCT_BUG", shouldCreateBug: false }));
  assert.equal(result.shouldCreateBug, false);
  assert.equal(result.policy.adjusted, false);
  assert.equal(result.policy.originalShouldCreateBug, false);
});

// --- TEST_BUG: false path (no-op, still recorded honestly) ---------------

test("TEST_BUG + false: remains false, not adjusted", () => {
  const result = applyAgentPolicy(baseResult({ classification: "TEST_BUG", shouldCreateBug: false }));
  assert.equal(result.shouldCreateBug, false);
  assert.equal(result.policy.adjusted, false);
  assert.equal(result.policy.originalShouldCreateBug, false);
});

// --- every other non-product classification: true forced to false --------

for (const classification of ["FLAKY_TEST", "ENVIRONMENT", "EXTERNAL_DEPENDENCY", "UNKNOWN"]) {
  test(`${classification} + true: forced to false, adjusted=true`, () => {
    const result = applyAgentPolicy(baseResult({ classification, shouldCreateBug: true }));
    assert.equal(result.shouldCreateBug, false);
    assert.equal(result.policy.adjusted, true);
    assert.equal(result.policy.originalShouldCreateBug, true);
  });

  test(`${classification} + false: remains false, adjusted=false`, () => {
    const result = applyAgentPolicy(baseResult({ classification, shouldCreateBug: false }));
    assert.equal(result.shouldCreateBug, false);
    assert.equal(result.policy.adjusted, false);
    assert.equal(result.policy.originalShouldCreateBug, false);
  });
}

// --- immutability ----------------------------------------------------------

test("applyAgentPolicy does not mutate its input", () => {
  const input = Object.freeze(baseResult({ classification: "TEST_BUG", shouldCreateBug: true }));
  const output = applyAgentPolicy(input);

  assert.equal(input.shouldCreateBug, true, "input must be untouched");
  assert.equal("policy" in input, false, "input must not gain a policy field");
  assert.notEqual(output, input, "a new object must be returned, not the same reference");
});

test("applyAgentPolicy returns a new object even when nothing was adjusted", () => {
  const input = Object.freeze(baseResult({ classification: "PRODUCT_BUG", shouldCreateBug: true }));
  const output = applyAgentPolicy(input);
  assert.notEqual(output, input);
});

// --- LLM/input has no authority over policy metadata ----------------------
// If the input already contains a `policy` key (e.g. a confused or
// adversarial provider echoing the shape back), it must never be trusted -
// the application always computes and overwrites it from scratch.

test("untrusted input policy metadata is ignored and replaced with the authoritative computation", () => {
  const input = baseResult({
    classification: "TEST_BUG",
    shouldCreateBug: true,
    policy: { adjusted: false, originalShouldCreateBug: false },
  });

  const result = applyAgentPolicy(input);

  assert.equal(result.shouldCreateBug, false);
  assert.equal(result.policy.adjusted, true);
  assert.equal(result.policy.originalShouldCreateBug, true);
});

// --- other fields pass through untouched -----------------------------------

test("fields unrelated to the policy decision pass through unchanged", () => {
  const input = baseResult({
    classification: "TEST_BUG",
    shouldCreateBug: true,
    confidence: 0.77,
    rootCause: "A very specific root cause.",
    evidence: ["one", "two"],
    recommendedFix: { file: "cypress/e2e/tests/example.cy.js", description: "Do the deterministic thing." },
    shouldRetry: true,
  });

  const result = applyAgentPolicy(input);

  assert.equal(result.confidence, 0.77);
  assert.equal(result.rootCause, "A very specific root cause.");
  assert.deepEqual(result.evidence, ["one", "two"]);
  assert.deepEqual(result.recommendedFix, { file: "cypress/e2e/tests/example.cy.js", description: "Do the deterministic thing." });
  assert.equal(result.shouldRetry, true, "shouldRetry is out of scope for this policy and must be untouched");
});
