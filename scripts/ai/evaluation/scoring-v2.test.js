"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { evaluateDatasetV2 } = require("./scoring-v2");

const DATASET_V2_PATH = path.join(__dirname, "dataset-v2.json");

function loadRealDatasetV2() {
  return JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf8"));
}

test("real Dataset v2 baseline: classification/action metrics match hand-computed expectations", () => {
  const { metrics } = evaluateDatasetV2(loadRealDatasetV2());

  assert.equal(metrics.totalSamples, 6);
  assert.equal(metrics.classificationScorable, 5);
  assert.equal(metrics.classificationAmbiguous, 1);
  assert.equal(metrics.classificationCorrect, 4);
  assert.equal(metrics.classificationIncorrect, 1);
  assert.equal(metrics.classificationAccuracy, 0.8);

  assert.equal(metrics.shouldRetryCorrect, 5);
  assert.equal(metrics.shouldRetryIncorrect, 1);

  assert.equal(metrics.shouldCreateBugCorrect, 6);
  assert.equal(metrics.shouldCreateBugIncorrect, 0);
  assert.equal(metrics.shouldCreateBugAccuracy, 1);
});

test("Experiment #5 ambiguity semantics are unchanged: excluded from classification denominator, still an 'ambiguous' status", () => {
  const { samples } = evaluateDatasetV2(loadRealDatasetV2());
  const exp5 = samples.find((s) => s.id === "experiment-5-real-flaky-test");
  assert.equal(exp5.isAmbiguous, true);
  assert.equal(exp5.classification.status, "ambiguous");
});

test("shouldRetry semantics unchanged: scored for every sample regardless of ambiguity", () => {
  const { samples } = evaluateDatasetV2(loadRealDatasetV2());
  const exp2 = samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(exp2.shouldRetry.correct, false); // groundTruth false, actual true
  const exp5 = samples.find((s) => s.id === "experiment-5-real-flaky-test");
  assert.equal(exp5.shouldRetry.correct, true); // groundTruth true, actual true, still scored despite ambiguity
});

test("final shouldCreateBug semantics unchanged: scored against finalShouldCreateBug, not originalShouldCreateBug", () => {
  const { samples } = evaluateDatasetV2(loadRealDatasetV2());
  const exp3 = samples.find((s) => s.id === "experiment-3-application-like-mismatch");
  assert.equal(exp3.shouldCreateBug.correct, true);
  assert.equal(exp3.shouldCreateBug.actual, true); // finalShouldCreateBug, matches groundTruth.shouldCreateBug=true
});

test("correlationApplicable count is 2 for the real Dataset v2 (Scenario A + B only)", () => {
  const { metrics, samples } = evaluateDatasetV2(loadRealDatasetV2());
  assert.equal(metrics.correlation.applicable, 2);
  assert.equal(metrics.correlation.notApplicable, 4);

  const applicableIds = samples.filter((s) => s.correlationApplicable).map((s) => s.id).sort();
  assert.deepEqual(applicableIds, ["experiment-A-multi-browser-same-signature", "experiment-B-multi-browser-different-signatures"]);
});

test("Scenario A and B both have correlationConstruction=pass and correlationTransport=pass", () => {
  const { samples } = evaluateDatasetV2(loadRealDatasetV2());
  for (const id of ["experiment-A-multi-browser-same-signature", "experiment-B-multi-browser-different-signatures"]) {
    const sample = samples.find((s) => s.id === id);
    assert.equal(sample.quality.correlationConstruction, "pass", `${id}: correlationConstruction`);
    assert.equal(sample.quality.correlationTransport, "pass", `${id}: correlationTransport`);
  }
});

test("Scenario A and B both have correlationReasoning=partial (the known Roadmap #6 baseline finding)", () => {
  const { samples } = evaluateDatasetV2(loadRealDatasetV2());
  for (const id of ["experiment-A-multi-browser-same-signature", "experiment-B-multi-browser-different-signatures"]) {
    const sample = samples.find((s) => s.id === id);
    assert.equal(sample.quality.correlationReasoning, "partial", `${id}: correlationReasoning`);
  }
});

test("all four migrated v1 samples have not_applicable correlation quality", () => {
  const { samples } = evaluateDatasetV2(loadRealDatasetV2());
  const migratedIds = [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-5-real-flaky-test",
  ];
  for (const id of migratedIds) {
    const sample = samples.find((s) => s.id === id);
    assert.equal(sample.correlationApplicable, false, `${id}: correlationApplicable`);
    assert.equal(sample.quality.correlationConstruction, "not_applicable", `${id}: correlationConstruction`);
    assert.equal(sample.quality.correlationTransport, "not_applicable", `${id}: correlationTransport`);
    assert.equal(sample.quality.correlationReasoning, "not_applicable", `${id}: correlationReasoning`);
  }
});

test("correlation quality enum counts sum to totalSamples for each dimension", () => {
  const { metrics } = evaluateDatasetV2(loadRealDatasetV2());
  for (const dimension of ["construction", "transport", "reasoning"]) {
    const counts = metrics.correlation[dimension];
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, metrics.totalSamples, `${dimension} counts must sum to totalSamples`);
  }
});

test("no composite score exists anywhere in the metrics object", () => {
  const { metrics } = evaluateDatasetV2(loadRealDatasetV2());
  const keys = Object.keys(metrics);
  for (const key of keys) {
    assert.doesNotMatch(key, /score/i, `metrics must not contain a composite-sounding key ("${key}")`);
  }
});

test("zero applicable-correlation samples behaves safely (no NaN/Infinity, all not_applicable)", () => {
  const dataset = {
    version: 2,
    samples: [
      {
        id: "s1",
        scenario: "x",
        groundTruth: { classification: "TEST_BUG", shouldRetry: false, shouldCreateBug: false },
        actual: { classification: "TEST_BUG", confidence: 0.5, shouldRetry: false, originalShouldCreateBug: false, finalShouldCreateBug: false, policyAdjusted: false },
        quality: {
          classification: "pass",
          rootCause: "pass",
          evidence: "pass",
          recommendedFix: "pass",
          historyUsage: "neutral",
          fabricatedEvidence: false,
          correlationConstruction: "not_applicable",
          correlationTransport: "not_applicable",
          correlationReasoning: "not_applicable",
        },
        ambiguity: { isAmbiguous: false, reason: null },
        correlation: { applicable: false, observed: null },
        metadata: { experiment: 1, provider: "groq", model: "m", PR: 1, workflowRun: 1 },
      },
    ],
  };

  const { metrics } = evaluateDatasetV2(dataset);
  assert.equal(metrics.correlation.applicable, 0);
  assert.equal(metrics.correlation.notApplicable, 1);
  assert.equal(metrics.correlation.construction.not_applicable, 1);
  assert.equal(Number.isNaN(metrics.classificationAccuracy), false);
});
