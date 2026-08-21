"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateNormalizedFailure } = require("./normalized-failure");
const { extractFailedTests } = require("./collect-context");

function validMinimalFailure(overrides = {}) {
  return {
    title: "should do the thing",
    fullTitle: "Suite > should do the thing",
    specFile: "cypress/e2e/tests/example.cy.js",
    error: { message: "AssertionError: expected true to be false", stack: "at foo (bar.js:1:1)" },
    ...overrides,
  };
}

test("validateNormalizedFailure: a minimal valid failure passes", () => {
  const result = validateNormalizedFailure(validMinimalFailure());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

// --- current Cypress collector output actually satisfies the contract -----

test("validateNormalizedFailure: the ACTUAL current extractFailedTests() output satisfies the contract", () => {
  const reports = [
    {
      results: [
        {
          file: "cypress/e2e/tests/example.cy.js",
          suites: [
            {
              title: "Suite",
              tests: [
                {
                  title: "should do the thing",
                  fullTitle: "Suite should do the thing",
                  state: "failed",
                  duration: 123,
                  err: { message: "AssertionError: expected true to be false", estack: "at foo (bar.js:1:1)" },
                },
              ],
              suites: [],
            },
          ],
        },
      ],
    },
  ];

  const failedTests = extractFailedTests(reports);
  assert.equal(failedTests.length, 1, "expected exactly one real Cypress-shaped failed test");

  const result = validateNormalizedFailure(failedTests[0]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

// --- a framework-neutral synthetic failure proves the contract isn't -----
// --- secretly Cypress-shaped (not a claim of Playwright support) --------

test("validateNormalizedFailure: a generic synthetic failure with no Cypress-only fields (no suite/status/screenshot/duration) is valid", () => {
  const genericFailure = {
    title: "renders the results page",
    fullTitle: "Results page > renders the results page",
    specFile: "tests/results-page.spec.ts",
    error: { message: "expected element to be visible", stack: null },
  };

  const result = validateNormalizedFailure(genericFailure);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateNormalizedFailure: extra fields (e.g. current Cypress suite/status) are allowed, not rejected", () => {
  const withExtras = validMinimalFailure({ suite: "Suite", status: "failed", extraFutureField: "anything" });
  const result = validateNormalizedFailure(withExtras);
  assert.equal(result.valid, true);
});

test("validateNormalizedFailure: optional duration/screenshot are valid when absent, null, or well-typed", () => {
  assert.equal(validateNormalizedFailure(validMinimalFailure()).valid, true);
  assert.equal(validateNormalizedFailure(validMinimalFailure({ duration: null, screenshot: null })).valid, true);
  assert.equal(validateNormalizedFailure(validMinimalFailure({ duration: 42, screenshot: "path/to.png" })).valid, true);
});

// --- invalid cases ---------------------------------------------------------

test("validateNormalizedFailure: null is invalid", () => {
  assert.equal(validateNormalizedFailure(null).valid, false);
});

test("validateNormalizedFailure: a non-object is invalid", () => {
  assert.equal(validateNormalizedFailure("not an object").valid, false);
  assert.equal(validateNormalizedFailure(42).valid, false);
  assert.equal(validateNormalizedFailure(["array"]).valid, false);
});

test("validateNormalizedFailure: missing error is invalid", () => {
  const failure = validMinimalFailure();
  delete failure.error;
  const result = validateNormalizedFailure(failure);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("error")));
});

test("validateNormalizedFailure: an invalid error object (wrong message/stack types) is invalid", () => {
  const result = validateNormalizedFailure(validMinimalFailure({ error: { message: 123, stack: {} } }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("error.message")));
  assert.ok(result.errors.some((e) => e.includes("error.stack")));
});

test("validateNormalizedFailure: an invalid title type is invalid", () => {
  const result = validateNormalizedFailure(validMinimalFailure({ title: 123 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("title")));
});

test("validateNormalizedFailure: an invalid specFile type is invalid", () => {
  const result = validateNormalizedFailure(validMinimalFailure({ specFile: 123 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("specFile")));
});

test("validateNormalizedFailure: an invalid duration (present but not a finite number or null) is invalid", () => {
  assert.equal(validateNormalizedFailure(validMinimalFailure({ duration: "123" })).valid, false);
  assert.equal(validateNormalizedFailure(validMinimalFailure({ duration: Infinity })).valid, false);
});

test("validateNormalizedFailure: an invalid screenshot (present but not a string or null) is invalid", () => {
  assert.equal(validateNormalizedFailure(validMinimalFailure({ screenshot: 42 })).valid, false);
});

// --- no per-failure framework field, no mutation ---------------------------

test("validateNormalizedFailure: a per-failure 'framework' field is neither required nor validated - framework identity belongs to context.metadata, not the failure contract", () => {
  const result = validateNormalizedFailure(validMinimalFailure());
  assert.equal(result.valid, true);
  const withFramework = validateNormalizedFailure(validMinimalFailure({ framework: "cypress" }));
  assert.equal(withFramework.valid, true, "an incidental framework field must not be rejected either, since extras are allowed");
});

test("validateNormalizedFailure: does not mutate the input failure object", () => {
  const failure = validMinimalFailure();
  const snapshotBefore = JSON.stringify(failure);
  const errorRef = failure.error;

  validateNormalizedFailure(failure);

  assert.equal(JSON.stringify(failure), snapshotBefore);
  assert.equal(failure.error, errorRef);
  assert.deepEqual(Object.keys(failure).sort(), ["error", "fullTitle", "specFile", "title"]);
});
