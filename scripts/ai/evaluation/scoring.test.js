"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { evaluateDataset } = require("./scoring");

const DATASET_PATH = path.join(__dirname, "dataset.json");

function loadRealDataset() {
  return JSON.parse(fs.readFileSync(DATASET_PATH, "utf8"));
}

// Minimal valid sample used as a base for synthetic scoring tests, so each
// test only has to override the fields it's actually exercising.
function makeSample(overrides) {
  const base = {
    id: "sample-1",
    scenario: "some-scenario",
    groundTruth: {
      classification: "TEST_BUG",
      shouldRetry: false,
      shouldCreateBug: false,
    },
    actual: {
      classification: "TEST_BUG",
      confidence: 0.5,
      shouldRetry: false,
      originalShouldCreateBug: false,
      finalShouldCreateBug: false,
      policyAdjusted: false,
    },
    quality: {
      classification: "pass",
      rootCause: "pass",
      evidence: "pass",
      recommendedFix: "pass",
      historyUsage: "neutral",
      fabricatedEvidence: false,
    },
    ambiguity: {
      isAmbiguous: false,
      reason: null,
    },
    metadata: {
      experiment: 1,
      provider: "groq",
      model: "openai/gpt-oss-120b",
      PR: 1,
      workflowRun: 1,
    },
  };
  return { ...base, ...overrides };
}

test("all classifications correct: classification accuracy is 1", () => {
  const dataset = {
    version: 1,
    samples: [
      makeSample({ id: "a" }),
      makeSample({ id: "b" }),
    ],
  };
  const { metrics } = evaluateDataset(dataset);
  assert.equal(metrics.classificationCorrect, 2);
  assert.equal(metrics.classificationIncorrect, 0);
  assert.equal(metrics.classificationAccuracy, 1);
});

test("one classification mismatch: correct/incorrect counts reflect it", () => {
  const dataset = {
    version: 1,
    samples: [
      makeSample({ id: "a" }),
      makeSample({
        id: "b",
        actual: { ...makeSample().actual, classification: "FLAKY_TEST" },
      }),
    ],
  };
  const { metrics, samples } = evaluateDataset(dataset);
  assert.equal(metrics.classificationCorrect, 1);
  assert.equal(metrics.classificationIncorrect, 1);
  assert.equal(metrics.classificationAccuracy, 0.5);
  const mismatch = samples.find((s) => s.id === "b");
  assert.equal(mismatch.classification.status, "incorrect");
  assert.equal(mismatch.classification.expected, "TEST_BUG");
  assert.equal(mismatch.classification.actual, "FLAKY_TEST");
});

test("ambiguous sample: included in total, excluded from classification denominator, included in action scoring", () => {
  const ambiguousSample = makeSample({
    id: "ambiguous-one",
    actual: { ...makeSample().actual, classification: "EXTERNAL_DEPENDENCY" },
    quality: { ...makeSample().quality, classification: "ambiguous" },
    ambiguity: { isAmbiguous: true, reason: "boundary case" },
  });
  const dataset = { version: 1, samples: [makeSample({ id: "a" }), ambiguousSample] };
  const { metrics, samples } = evaluateDataset(dataset);

  assert.equal(metrics.totalSamples, 2);
  assert.equal(metrics.classificationScorable, 1);
  assert.equal(metrics.classificationAmbiguous, 1);
  assert.equal(metrics.classificationCorrect, 1);
  assert.equal(metrics.classificationIncorrect, 0);

  const ambiguous = samples.find((s) => s.id === "ambiguous-one");
  assert.equal(ambiguous.classification.status, "ambiguous");
  assert.notEqual(ambiguous.classification.status, "correct");
  assert.notEqual(ambiguous.classification.status, "incorrect");

  // Still scored for actions - both samples' shouldRetry/shouldCreateBug
  // match ground truth here, so both count toward the 2-sample denominator.
  assert.equal(metrics.shouldRetryCorrect, 2);
  assert.equal(metrics.shouldCreateBugCorrect, 2);
});

test("shouldRetry mismatch is scored independently of classification", () => {
  const dataset = {
    version: 1,
    samples: [
      makeSample({ id: "a" }),
      makeSample({
        id: "b",
        actual: { ...makeSample().actual, shouldRetry: true },
      }),
    ],
  };
  const { metrics, samples } = evaluateDataset(dataset);
  assert.equal(metrics.shouldRetryCorrect, 1);
  assert.equal(metrics.shouldRetryIncorrect, 1);
  assert.equal(metrics.shouldRetryAccuracy, 0.5);
  assert.equal(samples.find((s) => s.id === "b").shouldRetry.correct, false);
});

test("shouldCreateBug is scored against finalShouldCreateBug, not originalShouldCreateBug", () => {
  const dataset = {
    version: 1,
    samples: [
      makeSample({
        id: "policy-adjusted",
        groundTruth: { classification: "TEST_BUG", shouldRetry: false, shouldCreateBug: false },
        actual: {
          classification: "TEST_BUG",
          confidence: 0.5,
          shouldRetry: false,
          originalShouldCreateBug: true,
          finalShouldCreateBug: false,
          policyAdjusted: true,
        },
      }),
    ],
  };
  const { metrics, samples } = evaluateDataset(dataset);
  // finalShouldCreateBug (false) matches groundTruth (false), even though
  // originalShouldCreateBug (true) does not.
  assert.equal(metrics.shouldCreateBugCorrect, 1);
  assert.equal(metrics.shouldCreateBugIncorrect, 0);
  assert.equal(samples[0].shouldCreateBug.correct, true);
});

test("policyAdjusted=true is counted as a policy intervention", () => {
  const dataset = {
    version: 1,
    samples: [
      makeSample({ id: "a", actual: { ...makeSample().actual, policyAdjusted: true } }),
      makeSample({ id: "b" }),
    ],
  };
  const { metrics } = evaluateDataset(dataset);
  assert.equal(metrics.policyInterventions, 1);
});

test("zero classification-scorable samples yields accuracy = null, not NaN", () => {
  const dataset = {
    version: 1,
    samples: [
      makeSample({
        id: "only-ambiguous",
        quality: { ...makeSample().quality, classification: "ambiguous" },
        ambiguity: { isAmbiguous: true, reason: "boundary case" },
      }),
    ],
  };
  const { metrics } = evaluateDataset(dataset);
  assert.equal(metrics.classificationScorable, 0);
  assert.equal(metrics.classificationAccuracy, null);
  assert.equal(Number.isNaN(metrics.classificationAccuracy), false);
});

test("qualitative aggregates count each enum value across samples, not_applicable is not treated as fail", () => {
  const dataset = {
    version: 1,
    samples: [
      makeSample({
        id: "a",
        quality: {
          classification: "pass",
          rootCause: "pass",
          evidence: "not_applicable",
          recommendedFix: "not_applicable",
          historyUsage: "not_clear",
          fabricatedEvidence: false,
        },
      }),
      makeSample({
        id: "b",
        quality: {
          classification: "pass",
          rootCause: "fail",
          evidence: "partial",
          recommendedFix: "pass",
          historyUsage: "appropriate",
          fabricatedEvidence: false,
        },
      }),
    ],
  };
  const { metrics } = evaluateDataset(dataset);
  assert.deepEqual(metrics.qualitative.rootCause, { pass: 1, partial: 0, fail: 1, not_applicable: 0 });
  assert.deepEqual(metrics.qualitative.evidence, { pass: 0, partial: 1, fail: 0, not_applicable: 1 });
  assert.deepEqual(metrics.qualitative.recommendedFix, { pass: 1, partial: 0, fail: 0, not_applicable: 1 });
  assert.deepEqual(metrics.qualitative.historyUsage, { appropriate: 1, neutral: 0, misleading: 0, not_clear: 1 });
});

test("real dataset.json baseline: computed metrics match the current v1 content", () => {
  const dataset = loadRealDataset();
  const { metrics, samples } = evaluateDataset(dataset);

  assert.equal(metrics.totalSamples, 4);
  assert.equal(metrics.classificationScorable, 3);
  assert.equal(metrics.classificationAmbiguous, 1);
  assert.equal(metrics.classificationCorrect, 2);
  assert.equal(metrics.classificationIncorrect, 1);

  assert.equal(metrics.shouldRetryCorrect, 3);
  assert.equal(metrics.shouldRetryIncorrect, 1);

  assert.equal(metrics.shouldCreateBugCorrect, 4);
  assert.equal(metrics.shouldCreateBugIncorrect, 0);

  assert.equal(metrics.policyInterventions, 0);

  const ambiguousSample = samples.find((s) => s.id === "experiment-5-real-flaky-test");
  assert.equal(ambiguousSample.isAmbiguous, true);
  assert.equal(ambiguousSample.classification.status, "ambiguous");

  const mismatchSample = samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(mismatchSample.classification.status, "incorrect");
});
