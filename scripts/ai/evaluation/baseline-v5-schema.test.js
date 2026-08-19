"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateBaselineV5 } = require("./baseline-v5-schema");

function makeBaseline(overrides = {}) {
  return {
    version: 1,
    datasetVersion: 5,
    samples: {
      "fixture-sample": {
        classificationStatus: "pass",
        shouldRetryCorrect: true,
        shouldCreateBugCorrect: true,
        modelShouldCreateBugCorrect: true,
        fabricatedEvidence: false,
        rootCause: "pass",
        evidence: "pass",
        recommendedFix: "pass",
        correlationConstruction: "not_applicable",
        correlationTransport: "not_applicable",
        correlationReasoning: "not_applicable",
        knowledgeSelectionCorrect: "not_applicable",
        knowledgeUsage: "not_applicable",
        knowledgeGrounding: "not_applicable",
        inferenceQuality: null,
      },
    },
    ...overrides,
  };
}

test("a minimal valid baseline passes validation", () => {
  const result = validateBaselineV5(makeBaseline());
  assert.deepEqual(result.errors, []);
});

test("datasetVersion must be exactly 5", () => {
  const baseline = makeBaseline({ datasetVersion: 4 });
  const result = validateBaselineV5(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("datasetVersion")));
});

test("modelShouldCreateBugCorrect accepts boolean or null", () => {
  const baselineTrue = makeBaseline();
  baselineTrue.samples["fixture-sample"].modelShouldCreateBugCorrect = false;
  assert.deepEqual(validateBaselineV5(baselineTrue).errors, []);

  const baselineNull = makeBaseline();
  baselineNull.samples["fixture-sample"].modelShouldCreateBugCorrect = null;
  assert.deepEqual(validateBaselineV5(baselineNull).errors, []);
});

test("modelShouldCreateBugCorrect rejects non-boolean, non-null values", () => {
  const baseline = makeBaseline();
  baseline.samples["fixture-sample"].modelShouldCreateBugCorrect = "true";
  const result = validateBaselineV5(baseline);
  assert.equal(result.valid, false);
});

test("inferenceQuality accepts a ternary value or null", () => {
  const baseline = makeBaseline();
  baseline.samples["fixture-sample"].inferenceQuality = "partial";
  assert.deepEqual(validateBaselineV5(baseline).errors, []);
});

test("knowledgeSelectionCorrect must be one of the ternary values", () => {
  const baseline = makeBaseline();
  baseline.samples["fixture-sample"].knowledgeSelectionCorrect = "maybe";
  const result = validateBaselineV5(baseline);
  assert.equal(result.valid, false);
});

test("the real baseline-v5.json validates cleanly", () => {
  const raw = fs.readFileSync(path.join(__dirname, "baseline-v5.json"), "utf8");
  const baseline = JSON.parse(raw);
  const result = validateBaselineV5(baseline);
  assert.deepEqual(result.errors, []);
});
