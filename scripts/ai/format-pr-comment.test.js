"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatComment, formatResolvedComment, MARKER } = require("./format-pr-comment");

function baseResult(overrides = {}) {
  return {
    test: {
      title: "should remove subcategories from the DOM after collapsing the parent category",
      specFile: "cypress/e2e/tests/category_tree_behavior.cy.js",
    },
    classification: "TEST_BUG",
    confidence: 0.82,
    summary: "The test asserts DOM removal before the tree component's collapse animation settles.",
    rootCause: "Test does not account for the collapse animation timing.",
    evidence: [
      "err.message: AssertionError: Timed out retrying after 10000ms",
      "Test source: subCategories.getRestaurant().should('not.exist')",
    ],
    recommendedFix: {
      file: "cypress/e2e/tests/category_tree_behavior.cy.js",
      description: "Assert on a stable state instead of DOM-removal timing.",
    },
    shouldCreateBug: false,
    shouldRetry: false,
    ...overrides,
  };
}

test("formatComment: typical single-failure report includes every required field", () => {
  const body = formatComment({
    browser: "chrome",
    report: { model: "gpt-4o-mini", results: [baseResult()] },
    runUrl: "https://github.com/x/y/actions/runs/1",
  });

  assert.match(body, /🤖 QA Agent — E2E Failure Analysis/);
  assert.match(body, /\*\*Browser:\*\*\nchrome/);
  assert.match(body, /`TEST_BUG`/);
  assert.match(body, /82%/);
  assert.match(body, /\*\*Create product bug:\*\*\nNo/);
  assert.match(body, /\*\*Retry recommended:\*\*\nNo/);
  assert.ok(body.includes(MARKER("chrome")));
});

test("formatComment: never leaks stack traces or raw context.json references", () => {
  const body = formatComment({ browser: "chrome", report: { results: [baseResult()] } });
  assert.doesNotMatch(body.toLowerCase(), /stack/);
  assert.doesNotMatch(body.toLowerCase(), /context\.json/);
});

test("formatComment: multiple failed tests in one job become one comment with numbered blocks", () => {
  const results = [baseResult(), baseResult({ test: { title: "second failing test", specFile: "x.cy.js" }, shouldCreateBug: true, shouldRetry: true })];
  const body = formatComment({ browser: "edge", report: { results } });

  assert.match(body, /Failure 1 of 2/);
  assert.match(body, /Failure 2 of 2/);
  assert.match(body, /second failing test/);
  const markerCount = (body.match(/qa-agent-report:edge/g) || []).length;
  assert.equal(markerCount, 1, "exactly one marker per comment, however many failures it covers");
});

test("formatComment: null recommendedFix renders a clear fallback, not a crash", () => {
  const body = formatComment({ browser: "chrome", report: { results: [baseResult({ recommendedFix: null })] } });
  assert.match(body, /No specific fix recommended/);
});

test("formatComment: empty evidence array renders a placeholder", () => {
  const body = formatComment({ browser: "chrome", report: { results: [baseResult({ evidence: [] })] } });
  assert.match(body, /\(none provided\)/);
});

test("formatComment: oversized fields are truncated with a visible marker", () => {
  const results = [
    baseResult({
      summary: "x".repeat(5000),
      evidence: Array.from({ length: 20 }, (_, i) => `evidence item number ${i} `.repeat(20)),
    }),
  ];
  const body = formatComment({ browser: "chrome", report: { results } });
  assert.match(body, /…/, "long summary should be truncated with an ellipsis");
  assert.match(body, /\+15 more/, "evidence list should be capped with a count of the rest");
});

test("formatComment: empty or malformed report never throws", () => {
  assert.doesNotThrow(() => formatComment({ browser: "chrome", report: { results: [] } }));
  assert.doesNotThrow(() => formatComment({ browser: "chrome", report: {} }));
  assert.doesNotThrow(() => formatComment({ browser: "chrome", report: null }));
});

test("formatResolvedComment: carries the same marker as the failure comment for the same browser", () => {
  const body = formatResolvedComment({ browser: "chrome", runUrl: "https://github.com/x/y/actions/runs/2" });
  assert.ok(body.includes(MARKER("chrome")));
  assert.match(body, /Resolved/);
  assert.match(body, /\*\*Browser:\*\*\nchrome/);
});
