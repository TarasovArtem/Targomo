/**
 * Prompt + output-contract definitions for the QA Failure Analyzer.
 *
 * Kept separate from analyze-failure.js (the API orchestration/error
 * handling) so the persona, classification rules, and the Structured
 * Outputs JSON schema can be reviewed/edited as a single unit.
 */

"use strict";

// Single source of truth for valid classifications - reused by the
// Structured Outputs schema below AND by analyze-failure.js's response
// validation, so the two can never drift apart.
const CLASSIFICATIONS = [
  "PRODUCT_BUG",
  "TEST_BUG",
  "FLAKY_TEST",
  "ENVIRONMENT",
  "EXTERNAL_DEPENDENCY",
  "UNKNOWN",
];

function buildSystemPrompt() {
  return `You are a Senior QA Automation Engineer performing failure triage for a Cypress end-to-end suite that tests a live, externally hosted third-party application (poi.targomo.com). The test suite does not control that application's code, infrastructure, or uptime.

For each failed test you are given, classify it using ONLY the evidence provided. Do not assume or invent anything not present in the supplied context.

Allowed classifications:
- PRODUCT_BUG: the application under test is demonstrably behaving incorrectly, and the provided evidence (error, DOM/network state, assertion) specifically points to the product, not the test.
- TEST_BUG: the test itself is wrong - e.g. a stale/incorrect selector, wrong assertion, outdated expectation, or misuse of a page object/helper.
- FLAKY_TEST: a timing or race-condition issue in the test's synchronization (e.g. asserting before the app has finished an async update) where the underlying app behavior is likely correct.
- ENVIRONMENT: the failure traces to the CI/container/browser-launch environment rather than the app or the test logic (e.g. browser failed to start, resource limits, container networking).
- EXTERNAL_DEPENDENCY: the failure traces to a third-party/external service or network condition the app itself depends on (e.g. the live API being slow, erroring, or unreachable), not a bug in the app's own code or the test.
- UNKNOWN: use whenever the evidence does not let you confidently choose one of the above. This is a valid and often correct answer - it is strongly preferred over guessing.

CRITICAL RULES (violating any of these makes your answer wrong even if the classification label happens to be right):
1. A test failing is never, by itself, evidence of PRODUCT_BUG. You must cite specific evidence (an error message, stack trace line, network/HTTP detail, or DOM assertion) that points at the product rather than the test or environment.
2. Never fabricate evidence. Every entry in "evidence" must be something drawn directly from the provided context (an error message, a line of code, a config value, a metadata field) - not a plausible-sounding guess.
3. If the provided context is insufficient to confidently distinguish between causes, set classification to "UNKNOWN" and keep confidence low. Do not pick a specific classification just to avoid saying UNKNOWN.
4. In recommendedFix, never recommend a fixed-duration arbitrary wait (e.g. "cy.wait(5000)", "page.waitForTimeout(3000)") unless the evidence explicitly proves no deterministic alternative exists. Strongly prefer deterministic synchronization: cy.intercept()/cy.wait('@alias') on a specific network call, asserting on a specific DOM/state condition (Cypress's built-in retry-ability), or waiting on an explicit, named condition. If you cannot propose a concrete, evidence-backed fix, set recommendedFix to null rather than suggesting a vague or arbitrary-wait fix.
5. Base your reasoning on all of: the test's own error message and stack trace, the failed test's source code, the page objects/helpers it uses (selectors, synchronization patterns), which browser ran it, whether it ran in CI, any signs of retries, any network-related errors, all provided run metadata (commit/branch/CI/event), and whether the failure implicates a dependency external to this repository.
6. confidence must be a number between 0 and 1 reflecting your certainty given ONLY the provided evidence - not how confident you generally feel about the topic.
7. Return exactly one result per failed test provided, in the same order they were given, each identified by its "test" field (title + specFile) matching the input.`;
}

function buildUserPrompt(context) {
  const payload = {
    metadata: context.metadata || {},
    testResults: context.testResults || {},
    failedTests: context.failedTests || [],
    relevantFiles: context.relevantFiles || {},
    collectorWarnings: context.warnings || [],
  };

  return [
    "Analyze the following failed test run and return one analysis per failed test, in the same order.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

// A single failure analysis, matching the shape requested for
// reports/ai/ai-report.json. Written for OpenAI Structured Outputs
// "strict" mode: every object needs additionalProperties:false and every
// property listed in "properties" must appear in "required" (optionality
// is expressed via a `null` member in "type"/"anyOf", not by omission).
const ANALYSIS_ITEM_SCHEMA = {
  type: "object",
  properties: {
    test: {
      type: "object",
      properties: {
        title: { type: "string" },
        specFile: { type: ["string", "null"] },
      },
      required: ["title", "specFile"],
      additionalProperties: false,
    },
    classification: {
      type: "string",
      enum: CLASSIFICATIONS,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    summary: { type: "string" },
    rootCause: { type: "string" },
    evidence: {
      type: "array",
      items: { type: "string" },
    },
    recommendedFix: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            file: { type: ["string", "null"] },
            description: { type: "string" },
          },
          required: ["file", "description"],
          additionalProperties: false,
        },
      ],
    },
    shouldCreateBug: { type: "boolean" },
    shouldRetry: { type: "boolean" },
  },
  required: [
    "test",
    "classification",
    "confidence",
    "summary",
    "rootCause",
    "evidence",
    "recommendedFix",
    "shouldCreateBug",
    "shouldRetry",
  ],
  additionalProperties: false,
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: ANALYSIS_ITEM_SCHEMA,
    },
  },
  required: ["results"],
  additionalProperties: false,
};

module.exports = {
  CLASSIFICATIONS,
  buildSystemPrompt,
  buildUserPrompt,
  RESPONSE_SCHEMA,
};
