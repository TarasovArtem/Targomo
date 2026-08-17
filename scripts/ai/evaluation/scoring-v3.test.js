"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { evaluateDatasetV3 } = require("./scoring-v3");

const DATASET_V3_PATH = path.join(__dirname, "dataset-v3.json");

function loadRealDatasetV3() {
  return JSON.parse(fs.readFileSync(DATASET_V3_PATH, "utf8"));
}

test("real Dataset v3 baseline: classification/action metrics match hand-computed expectations", () => {
  const { metrics } = evaluateDatasetV3(loadRealDatasetV3());

  assert.equal(metrics.totalSamples, 7);
  assert.equal(metrics.classificationScorable, 6);
  assert.equal(metrics.classificationAmbiguous, 1);
  assert.equal(metrics.classificationCorrect, 5);
  assert.equal(metrics.classificationIncorrect, 1);
  assert.equal(metrics.classificationAccuracy, 5 / 6);

  assert.equal(metrics.shouldRetryCorrect, 6);
  assert.equal(metrics.shouldRetryIncorrect, 1);

  assert.equal(metrics.shouldCreateBugCorrect, 7);
  assert.equal(metrics.shouldCreateBugIncorrect, 0);
  assert.equal(metrics.shouldCreateBugAccuracy, 1);
});

test("v2 classification/action semantics preserved: the six inherited samples score identically to Dataset v2", () => {
  const { samples } = evaluateDatasetV3(loadRealDatasetV3());
  const exp2 = samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(exp2.classification.status, "incorrect");
  assert.equal(exp2.shouldRetry.correct, false);

  const exp5 = samples.find((s) => s.id === "experiment-5-real-flaky-test");
  assert.equal(exp5.isAmbiguous, true);
  assert.equal(exp5.classification.status, "ambiguous");
});

test("ambiguity preserved: only experiment-5 is ambiguous, Experiment #41 is not", () => {
  const { samples } = evaluateDatasetV3(loadRealDatasetV3());
  const ambiguousIds = samples.filter((s) => s.isAmbiguous).map((s) => s.id);
  assert.deepEqual(ambiguousIds, ["experiment-5-real-flaky-test"]);

  const exp41 = samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");
  assert.equal(exp41.isAmbiguous, false);
  assert.equal(exp41.classification.status, "correct");
});

test("Experiment #41 action semantics: shouldRetry and shouldCreateBug both correct", () => {
  const { samples } = evaluateDatasetV3(loadRealDatasetV3());
  const exp41 = samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");
  assert.equal(exp41.shouldRetry.correct, true);
  assert.equal(exp41.shouldCreateBug.correct, true);
});

test("evidenceGrounding.fabricatedEvidence: exactly one true (Experiment #41), rest false", () => {
  const { metrics, samples } = evaluateDatasetV3(loadRealDatasetV3());
  assert.deepEqual(metrics.evidenceGrounding.fabricatedEvidence, { false: 6, true: 1 });

  const trueSamples = samples.filter((s) => s.quality.fabricatedEvidence === true).map((s) => s.id);
  assert.deepEqual(trueSamples, ["experiment-41-correlation-necessary-grounding"]);
});

test("correlation applicable count is 3 (Scenario A + B + Experiment #41)", () => {
  const { metrics, samples } = evaluateDatasetV3(loadRealDatasetV3());
  assert.equal(metrics.correlation.applicable, 3);
  assert.equal(metrics.correlation.notApplicable, 4);

  const applicableIds = samples.filter((s) => s.correlationApplicable).map((s) => s.id).sort();
  assert.deepEqual(applicableIds, [
    "experiment-41-correlation-necessary-grounding",
    "experiment-A-multi-browser-same-signature",
    "experiment-B-multi-browser-different-signatures",
  ]);
});

test("correlationReasoning includes exactly one fail (Experiment #41), two partial (Scenario A/B)", () => {
  const { metrics } = evaluateDatasetV3(loadRealDatasetV3());
  assert.deepEqual(metrics.correlation.reasoning, { pass: 0, partial: 2, fail: 1, not_applicable: 4 });
});

test("Experiment #41 correlationConstruction/correlationTransport are both pass, correlationReasoning is fail", () => {
  const { samples } = evaluateDatasetV3(loadRealDatasetV3());
  const exp41 = samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");
  assert.equal(exp41.quality.correlationConstruction, "pass");
  assert.equal(exp41.quality.correlationTransport, "pass");
  assert.equal(exp41.quality.correlationReasoning, "fail");
});

test("qualitative aggregates reflect Experiment #41's one additional fail/fail/partial", () => {
  const { metrics } = evaluateDatasetV3(loadRealDatasetV3());
  assert.equal(metrics.qualitative.rootCause.fail, 1);
  assert.equal(metrics.qualitative.evidence.fail, 1);
  assert.equal(metrics.qualitative.recommendedFix.partial, 1);
});

test("no composite score exists anywhere in the metrics object", () => {
  const { metrics } = evaluateDatasetV3(loadRealDatasetV3());
  const keys = Object.keys(metrics);
  for (const key of keys) {
    assert.doesNotMatch(key, /score/i, `metrics must not contain a composite-sounding key ("${key}")`);
  }
});

test("correlation quality enum counts sum to totalSamples for each dimension", () => {
  const { metrics } = evaluateDatasetV3(loadRealDatasetV3());
  for (const dimension of ["construction", "transport", "reasoning"]) {
    const counts = metrics.correlation[dimension];
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, metrics.totalSamples, `${dimension} counts must sum to totalSamples`);
  }
});
