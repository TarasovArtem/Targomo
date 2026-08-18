"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { evaluateDatasetV4 } = require("./scoring-v4");

const DATASET_V4_PATH = path.join(__dirname, "dataset-v4.json");

function loadRealDatasetV4() {
  return JSON.parse(fs.readFileSync(DATASET_V4_PATH, "utf8"));
}

test("real Dataset v4 baseline: classification/action metrics match hand-computed expectations", () => {
  const { metrics } = evaluateDatasetV4(loadRealDatasetV4());

  assert.equal(metrics.totalSamples, 9);
  assert.equal(metrics.classificationScorable, 8);
  assert.equal(metrics.classificationAmbiguous, 1);
  assert.equal(metrics.classificationCorrect, 7);
  assert.equal(metrics.classificationIncorrect, 1);
  assert.equal(metrics.classificationAccuracy, 7 / 8);

  assert.equal(metrics.shouldRetryCorrect, 8);
  assert.equal(metrics.shouldRetryIncorrect, 1);

  assert.equal(metrics.shouldCreateBugCorrect, 9);
  assert.equal(metrics.shouldCreateBugIncorrect, 0);
  assert.equal(metrics.shouldCreateBugAccuracy, 1);
});

test("v3 classification/action semantics preserved: the seven inherited samples score identically to Dataset v3", () => {
  const { samples } = evaluateDatasetV4(loadRealDatasetV4());
  const exp2 = samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(exp2.classification.status, "incorrect");
  assert.equal(exp2.shouldRetry.correct, false);

  const exp5 = samples.find((s) => s.id === "experiment-5-real-flaky-test");
  assert.equal(exp5.isAmbiguous, true);
  assert.equal(exp5.classification.status, "ambiguous");

  const exp41 = samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");
  assert.equal(exp41.isAmbiguous, false);
  assert.equal(exp41.classification.status, "correct");
});

test("ambiguity: only experiment-5 is ambiguous - neither post-prompt sample is ambiguous", () => {
  const { samples } = evaluateDatasetV4(loadRealDatasetV4());
  const ambiguousIds = samples.filter((s) => s.isAmbiguous).map((s) => s.id);
  assert.deepEqual(ambiguousIds, ["experiment-5-real-flaky-test"]);
});

test("both post-prompt samples: classification correct, shouldRetry correct, shouldCreateBug correct", () => {
  const { samples } = evaluateDatasetV4(loadRealDatasetV4());
  for (const id of ["experiment-45-post-prompt-grounding-revalidation", "experiment-47-post-prompt-grounding-revalidation"]) {
    const sample = samples.find((s) => s.id === id);
    assert.equal(sample.classification.status, "correct", id);
    assert.equal(sample.shouldRetry.correct, true, id);
    assert.equal(sample.shouldCreateBug.correct, true, id);
  }
});

test("policyAdjusted: only the PR #47 sample is true, the PR #45 sample is false", () => {
  const { samples, metrics } = evaluateDatasetV4(loadRealDatasetV4());
  const obs1 = samples.find((s) => s.id === "experiment-45-post-prompt-grounding-revalidation");
  const obs2 = samples.find((s) => s.id === "experiment-47-post-prompt-grounding-revalidation");
  assert.equal(obs1.policyAdjusted, false);
  assert.equal(obs2.policyAdjusted, true);
  assert.equal(metrics.policyInterventions, 1);
});

test("evidenceGrounding.fabricatedEvidence: exactly one true (Experiment #41), rest false", () => {
  const { metrics, samples } = evaluateDatasetV4(loadRealDatasetV4());
  assert.deepEqual(metrics.evidenceGrounding.fabricatedEvidence, { false: 8, true: 1 });

  const trueSamples = samples.filter((s) => s.quality.fabricatedEvidence === true).map((s) => s.id);
  assert.deepEqual(trueSamples, ["experiment-41-correlation-necessary-grounding"]);
});

// Correlation applicable should increase by 2 relative to Dataset v3's 3
// (Scenario A + B + Experiment #41), since both new samples are
// multi-browser correlation scenarios - computed from data, never hardcoded
// in the scoring module itself.
test("correlation applicable count is 5 (Scenario A + B + Experiment #41 + both post-prompt samples)", () => {
  const { metrics, samples } = evaluateDatasetV4(loadRealDatasetV4());
  assert.equal(metrics.correlation.applicable, 5);
  assert.equal(metrics.correlation.notApplicable, 4);

  const applicableIds = samples.filter((s) => s.correlationApplicable).map((s) => s.id).sort();
  assert.deepEqual(applicableIds, [
    "experiment-41-correlation-necessary-grounding",
    "experiment-45-post-prompt-grounding-revalidation",
    "experiment-47-post-prompt-grounding-revalidation",
    "experiment-A-multi-browser-same-signature",
    "experiment-B-multi-browser-different-signatures",
  ]);
});

test("correlationReasoning: two pass (post-prompt samples), two partial (Scenario A/B), one fail (Experiment #41)", () => {
  const { metrics } = evaluateDatasetV4(loadRealDatasetV4());
  assert.deepEqual(metrics.correlation.reasoning, { pass: 2, partial: 2, fail: 1, not_applicable: 4 });
});

test("both post-prompt samples: correlationConstruction/correlationTransport/correlationReasoning all pass", () => {
  const { samples } = evaluateDatasetV4(loadRealDatasetV4());
  for (const id of ["experiment-45-post-prompt-grounding-revalidation", "experiment-47-post-prompt-grounding-revalidation"]) {
    const sample = samples.find((s) => s.id === id);
    assert.equal(sample.quality.correlationConstruction, "pass", id);
    assert.equal(sample.quality.correlationTransport, "pass", id);
    assert.equal(sample.quality.correlationReasoning, "pass", id);
  }
});

test("Experiment #41 correlationConstruction/correlationTransport are both pass, correlationReasoning is fail", () => {
  const { samples } = evaluateDatasetV4(loadRealDatasetV4());
  const exp41 = samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");
  assert.equal(exp41.quality.correlationConstruction, "pass");
  assert.equal(exp41.quality.correlationTransport, "pass");
  assert.equal(exp41.quality.correlationReasoning, "fail");
});

test("qualitative aggregates: rootCause/evidence gain 2 pass each, recommendedFix gains 2 pass, relative to v3's shape", () => {
  const { metrics } = evaluateDatasetV4(loadRealDatasetV4());
  // Dataset v3's rootCause/evidence: pass=4 partial=2 fail=1; recommendedFix: pass=5 partial=1 fail=1
  // Dataset v4 adds two more pass-rated post-prompt samples to each.
  assert.deepEqual(metrics.qualitative.rootCause, { pass: 6, partial: 2, fail: 1, not_applicable: 0 });
  assert.deepEqual(metrics.qualitative.evidence, { pass: 6, partial: 2, fail: 1, not_applicable: 0 });
  assert.deepEqual(metrics.qualitative.recommendedFix, { pass: 7, partial: 1, fail: 1, not_applicable: 0 });
});

test("no composite score exists anywhere in the metrics object", () => {
  const { metrics } = evaluateDatasetV4(loadRealDatasetV4());
  const keys = Object.keys(metrics);
  for (const key of keys) {
    assert.doesNotMatch(key, /score/i, `metrics must not contain a composite-sounding key ("${key}")`);
  }
});

// Roadmap #13: providerAttempts/policyAdjusted/originalShouldCreateBug must
// never appear as, or feed into, any aggregate quality metric.
test("providerAttempts and provenance fields never appear as metrics keys", () => {
  const { metrics } = evaluateDatasetV4(loadRealDatasetV4());
  const serialized = JSON.stringify(metrics);
  assert.doesNotMatch(serialized, /providerAttempts/);
  assert.doesNotMatch(serialized, /firstAttemptError/);
  assert.doesNotMatch(serialized, /revalidationOfExperiment/);
});

test("correlation quality enum counts sum to totalSamples for each dimension", () => {
  const { metrics } = evaluateDatasetV4(loadRealDatasetV4());
  for (const dimension of ["construction", "transport", "reasoning"]) {
    const counts = metrics.correlation[dimension];
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, metrics.totalSamples, `${dimension} counts must sum to totalSamples`);
  }
});
