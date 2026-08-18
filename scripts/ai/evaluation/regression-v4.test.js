"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { compareEvaluationToBaselineV4, formatRegressionReportV4, run } = require("./regression-v4");
const { evaluateDatasetV4 } = require("./scoring-v4");

const DATASET_V4_PATH = path.join(__dirname, "dataset-v4.json");
const BASELINE_V4_PATH = path.join(__dirname, "baseline-v4.json");

function loadRealDatasetV4() {
  return JSON.parse(fs.readFileSync(DATASET_V4_PATH, "utf8"));
}

function loadRealBaselineV4() {
  return JSON.parse(fs.readFileSync(BASELINE_V4_PATH, "utf8"));
}

// Minimal synthetic sample matching the shape scoring-v4.js's
// evaluateDatasetV4() actually returns per sample.
function makeCurrentSample(id, overrides = {}) {
  const classificationStatus = overrides.classificationStatus || "correct";
  return {
    id,
    isAmbiguous: classificationStatus === "ambiguous",
    classification: { status: classificationStatus, expected: "TEST_BUG", actual: classificationStatus === "incorrect" ? "FLAKY_TEST" : "TEST_BUG" },
    shouldRetry: { correct: overrides.shouldRetryCorrect ?? true, expected: false, actual: overrides.shouldRetryCorrect ?? true },
    shouldCreateBug: { correct: overrides.shouldCreateBugCorrect ?? true, expected: false, actual: overrides.shouldCreateBugCorrect ?? true },
    policyAdjusted: false,
    quality: {
      classification: "pass",
      rootCause: overrides.rootCause || "pass",
      evidence: overrides.evidence || "pass",
      recommendedFix: overrides.recommendedFix || "pass",
      historyUsage: "neutral",
      fabricatedEvidence: overrides.fabricatedEvidence ?? false,
      correlationConstruction: overrides.correlationConstruction || "not_applicable",
      correlationTransport: overrides.correlationTransport || "not_applicable",
      correlationReasoning: overrides.correlationReasoning || "not_applicable",
    },
    correlationApplicable: (overrides.correlationConstruction || "not_applicable") !== "not_applicable",
  };
}

function makeBaselineSample(overrides = {}) {
  return {
    classificationStatus: overrides.classificationStatus || "pass",
    shouldRetryCorrect: overrides.shouldRetryCorrect ?? true,
    shouldCreateBugCorrect: overrides.shouldCreateBugCorrect ?? true,
    fabricatedEvidence: overrides.fabricatedEvidence ?? false,
    rootCause: overrides.rootCause || "pass",
    evidence: overrides.evidence || "pass",
    recommendedFix: overrides.recommendedFix || "pass",
    correlationConstruction: overrides.correlationConstruction || "not_applicable",
    correlationTransport: overrides.correlationTransport || "not_applicable",
    correlationReasoning: overrides.correlationReasoning || "not_applicable",
  };
}

// A 9-sample synthetic baseline mirroring the real Baseline v4's shape (4
// not-applicable + A/B/#41 applicable-correlation + both post-prompt samples
// applicable-correlation-all-pass), so per-test overrides read as "change
// just this one thing."
function makeSyntheticBaseline(overrides = {}) {
  return {
    version: 1,
    datasetVersion: 4,
    samples: {
      "exp-2": makeBaselineSample({ classificationStatus: "fail", shouldRetryCorrect: false }),
      "exp-3": makeBaselineSample(),
      "exp-4": makeBaselineSample(),
      "exp-5": makeBaselineSample({ classificationStatus: "ambiguous" }),
      "exp-A": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
      "exp-B": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
      "exp-41": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: true, rootCause: "fail", evidence: "fail", recommendedFix: "partial" }),
      "exp-45": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
      "exp-47": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
      ...overrides,
    },
  };
}

function makeSyntheticCurrentEvaluation(overrides = {}) {
  const samples = {
    "exp-2": makeCurrentSample("exp-2", { classificationStatus: "incorrect", shouldRetryCorrect: false }),
    "exp-3": makeCurrentSample("exp-3"),
    "exp-4": makeCurrentSample("exp-4"),
    "exp-5": makeCurrentSample("exp-5", { classificationStatus: "ambiguous" }),
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
    "exp-B": makeCurrentSample("exp-B", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: true, rootCause: "fail", evidence: "fail", recommendedFix: "partial" }),
    "exp-45": makeCurrentSample("exp-45", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
    "exp-47": makeCurrentSample("exp-47", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
    ...overrides,
  };
  return { metrics: {}, samples: Object.values(samples) };
}

// 1. real Dataset v4 vs real Baseline v4 -> UNCHANGED
test("real Dataset v4 vs real Baseline v4: status is UNCHANGED with 0 regressions, 0 improvements", () => {
  const currentEvaluation = evaluateDatasetV4(loadRealDatasetV4());
  const comparison = compareEvaluationToBaselineV4(currentEvaluation, loadRealBaselineV4());

  assert.equal(comparison.status, "UNCHANGED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(comparison.summary.improvements, 0);
});

// Experiment #41 remains a known deficiency, unchanged.
test("Experiment #41's frozen fabricatedEvidence/rootCause/evidence/correlationReasoning stay unchanged (known deficiencies)", () => {
  const currentEvaluation = evaluateDatasetV4(loadRealDatasetV4());
  const comparison = compareEvaluationToBaselineV4(currentEvaluation, loadRealBaselineV4());
  const exp41 = comparison.samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");

  assert.equal(exp41.fabricatedEvidence.change, "unchanged");
  assert.equal(exp41.fabricatedEvidence.baseline, true);
  assert.equal(exp41.rootCause.change, "unchanged");
  assert.equal(exp41.rootCause.baseline, "fail");
  assert.equal(exp41.evidence.change, "unchanged");
  assert.equal(exp41.evidence.baseline, "fail");
  assert.equal(exp41.correlationReasoning.change, "unchanged");
  assert.equal(exp41.correlationReasoning.baseline, "fail");
});

// Both post-prompt samples are unchanged against their own frozen baseline.
test("both post-prompt samples are unchanged against Baseline v4 (fabricatedEvidence false, all qualitative/correlation pass)", () => {
  const currentEvaluation = evaluateDatasetV4(loadRealDatasetV4());
  const comparison = compareEvaluationToBaselineV4(currentEvaluation, loadRealBaselineV4());

  for (const id of ["experiment-45-post-prompt-grounding-revalidation", "experiment-47-post-prompt-grounding-revalidation"]) {
    const sample = comparison.samples.find((s) => s.id === id);
    assert.equal(sample.fabricatedEvidence.change, "unchanged", id);
    assert.equal(sample.fabricatedEvidence.baseline, false, id);
    assert.equal(sample.rootCause.change, "unchanged", id);
    assert.equal(sample.evidence.change, "unchanged", id);
    assert.equal(sample.recommendedFix.change, "unchanged", id);
    assert.equal(sample.correlationReasoning.change, "unchanged", id);
  }
});

// ============================================================
// G. Regression protection: each of the 8 protected dimensions,
// individually, on a post-prompt sample, in isolation, yields REGRESSED.
// ============================================================

test("G1. fabricatedEvidence false -> true on exp-45 yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-45": makeCurrentSample("exp-45", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", fabricatedEvidence: true }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-45").fabricatedEvidence.change, "regression");
});

test("G2. rootCause pass -> partial on exp-45 yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-45": makeCurrentSample("exp-45", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", rootCause: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-45").rootCause.change, "regression");
});

test("G3. evidence pass -> partial on exp-45 yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-45": makeCurrentSample("exp-45", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", evidence: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-45").evidence.change, "regression");
});

test("G4. recommendedFix pass -> partial on exp-45 yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-45": makeCurrentSample("exp-45", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", recommendedFix: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-45").recommendedFix.change, "regression");
});

test("G5. correlationReasoning pass -> partial on exp-47 yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-47": makeCurrentSample("exp-47", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-47").correlationReasoning.change, "regression");
});

test("G6. classification correct -> incorrect on exp-47 yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-47": makeCurrentSample("exp-47", { classificationStatus: "incorrect", correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-47").classification.change, "regression");
});

test("G7. shouldRetry correct -> incorrect on exp-47 yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-47": makeCurrentSample("exp-47", { shouldRetryCorrect: false, correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-47").shouldRetry.change, "regression");
});

test("G8. shouldCreateBug correct -> incorrect on exp-47 yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-47": makeCurrentSample("exp-47", { shouldCreateBugCorrect: false, correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-47").shouldCreateBug.change, "regression");
});

// ============================================================
// H. Mixed transitions: an improvement elsewhere must never hide any one
// of the G1-G8 regressions.
// ============================================================

test("H1. exp-41 fabricatedEvidence improves (true->false) while exp-45 recommendedFix regresses (pass->fail) - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: false, rootCause: "fail", evidence: "fail", recommendedFix: "partial" }),
    "exp-45": makeCurrentSample("exp-45", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", recommendedFix: "fail" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-41").fabricatedEvidence.change, "improvement");
  assert.equal(comparison.samples.find((s) => s.id === "exp-45").recommendedFix.change, "regression");
});

test("H2. exp-41 correlationReasoning improves (fail->pass) while exp-47 evidence regresses (pass->fail) - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", fabricatedEvidence: true, rootCause: "fail", evidence: "fail", recommendedFix: "partial" }),
    "exp-47": makeCurrentSample("exp-47", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", evidence: "fail" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-41").correlationReasoning.change, "improvement");
  assert.equal(comparison.samples.find((s) => s.id === "exp-47").evidence.change, "regression");
});

test("H3. classification fixed on exp-2 (fail->pass) while exp-45 classification regresses (correct->incorrect) - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-2": makeCurrentSample("exp-2", { classificationStatus: "correct", shouldRetryCorrect: false }),
    "exp-45": makeCurrentSample("exp-45", { classificationStatus: "incorrect", correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-2").classification.change, "improvement");
  assert.equal(comparison.samples.find((s) => s.id === "exp-45").classification.change, "regression");
});

// ============================================================
// I. Aggregate masking: synthetic swaps where aggregate counts remain
// equal but one post-prompt sample regresses.
// ============================================================

test("I1. aggregate masking: exp-45 rootCause regresses (pass->fail) while exp-47 rootCause 'improves' the same amount from a lower baseline - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline({
    "exp-45": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", rootCause: "pass" }),
    "exp-47": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", rootCause: "fail" }),
  });
  const current = makeSyntheticCurrentEvaluation({
    "exp-45": makeCurrentSample("exp-45", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", rootCause: "fail" }),
    "exp-47": makeCurrentSample("exp-47", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", rootCause: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-45").rootCause.change, "regression");
  assert.equal(comparison.samples.find((s) => s.id === "exp-47").rootCause.change, "improvement");
  assert.equal(comparison.summary.regressions, 1);
  assert.equal(comparison.summary.improvements, 1);
});

test("I2. aggregate masking: exp-45 fabricatedEvidence regresses while exp-41 fabricatedEvidence improves at the same time - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-45": makeCurrentSample("exp-45", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", fabricatedEvidence: true }),
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: false, rootCause: "fail", evidence: "fail", recommendedFix: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV4(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-45").fabricatedEvidence.change, "regression");
  assert.equal(comparison.samples.find((s) => s.id === "exp-41").fabricatedEvidence.change, "improvement");
  assert.equal(comparison.summary.regressions, 1);
  assert.equal(comparison.summary.improvements, 1);
});

// ============================================================
// J. Provenance: providerAttempts/policyAdjusted-style provenance fields
// validate but never affect regression status by themselves.
// ============================================================

// The regression comparator's samples never even carry providerAttempts -
// scoring-v4.js never reads sample.metadata at all - so a change in
// providerAttempts cannot mechanically reach compareEvaluationToBaselineV4()
// in the first place. This test proves that structurally: the comparison
// output for an otherwise-identical pair of samples is byte-identical
// regardless of what the underlying dataset's metadata.providerAttempts is,
// because evaluateDatasetV4()/scoreSampleV4() never surface it.
test("J1. changing dataset metadata.providerAttempts (1 -> 2) does not, by itself, produce REGRESSED", () => {
  const dataset = loadRealDatasetV4();
  const mutated = JSON.parse(JSON.stringify(dataset));
  const sample = mutated.samples.find((s) => s.id === "experiment-47-post-prompt-grounding-revalidation");
  sample.metadata.providerAttempts = 2;
  sample.metadata.firstAttemptError = "some transient error";

  const baselineComparison = compareEvaluationToBaselineV4(evaluateDatasetV4(dataset), loadRealBaselineV4());
  const mutatedComparison = compareEvaluationToBaselineV4(evaluateDatasetV4(mutated), loadRealBaselineV4());

  assert.equal(baselineComparison.status, "UNCHANGED");
  assert.equal(mutatedComparison.status, "UNCHANGED");
  assert.deepEqual(mutatedComparison.samples, baselineComparison.samples, "changing providerAttempts must not change any per-sample comparison field");
});

// policyAdjusted (true -> false) on its own, with finalShouldCreateBug held
// constant, must not become a regression metric in Roadmap #13 - only
// finalShouldCreateBug's correctness against groundTruth.shouldCreateBug is
// ever scored (see scoring-v4.js's scoreSampleV4, which reads
// actual.finalShouldCreateBug, never actual.policyAdjusted, for the
// shouldCreateBug.correct field the comparator actually reads).
test("J2. changing dataset actual.policyAdjusted (true -> false) alone, with finalShouldCreateBug unchanged, does not produce REGRESSED", () => {
  const dataset = loadRealDatasetV4();
  const mutated = JSON.parse(JSON.stringify(dataset));
  const sample = mutated.samples.find((s) => s.id === "experiment-47-post-prompt-grounding-revalidation");
  assert.equal(sample.actual.policyAdjusted, true, "sanity check on the real fixture");
  sample.actual.policyAdjusted = false;
  sample.actual.originalShouldCreateBug = false; // consistent with policyAdjusted=false, finalShouldCreateBug stays false

  const mutatedComparison = compareEvaluationToBaselineV4(evaluateDatasetV4(mutated), loadRealBaselineV4());
  assert.equal(mutatedComparison.status, "UNCHANGED");
  assert.equal(mutatedComparison.summary.regressions, 0);
});

test("known Experiment #2 classification/recommendedFix deficiency (fail -> fail) is unchanged, not a new regression", () => {
  const currentEvaluation = evaluateDatasetV4(loadRealDatasetV4());
  const comparison = compareEvaluationToBaselineV4(currentEvaluation, loadRealBaselineV4());
  const exp2 = comparison.samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(exp2.classification.baseline, "fail");
  assert.equal(exp2.classification.current, "fail");
  assert.equal(exp2.classification.change, "unchanged");
  assert.equal(exp2.recommendedFix.baseline, "fail");
  assert.equal(exp2.recommendedFix.change, "unchanged");
});

test("Experiment #5 ambiguous classification remains informational, does not drive top-level status", () => {
  const currentEvaluation = evaluateDatasetV4(loadRealDatasetV4());
  const comparison = compareEvaluationToBaselineV4(currentEvaluation, loadRealBaselineV4());
  const exp5 = comparison.samples.find((s) => s.id === "experiment-5-real-flaky-test");
  assert.equal(exp5.classification.change, "informational");
});

test("a sample-set mismatch is reported as BASELINE_MISMATCH, not silently ignored", () => {
  const baseline = makeSyntheticBaseline();
  const currentSamples = makeSyntheticCurrentEvaluation().samples.filter((s) => s.id !== "exp-47");
  const comparison = compareEvaluationToBaselineV4({ metrics: {}, samples: currentSamples }, baseline);
  assert.equal(comparison.status, "BASELINE_MISMATCH");
  assert.equal(comparison.summary, null);
  assert.ok(comparison.errors.some((e) => e.includes('"exp-47"')));
});

test("offline guarantee: regression-v4.js does not actually use AI providers, credentials, or network calls", () => {
  const source = fs.readFileSync(path.join(__dirname, "regression-v4.js"), "utf8");
  const forbiddenPatterns = [
    /require\([^)]*providers/,
    /createProvider\s*\(/,
    /process\.env\.AI_API_KEY/,
    /process\.env\.GROQ_API_KEY/,
    /\bfetch\s*\(/,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(source), `expected no match for ${pattern} in regression-v4.js`);
  }
});

test("run(): the real dataset-v4.json vs the real baseline-v4.json returns exit code 0 with status UNCHANGED", () => {
  const result = run(DATASET_V4_PATH, BASELINE_V4_PATH);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Status: UNCHANGED/);
});

test("formatRegressionReportV4: reports Experiment #41's fabricatedEvidence/rootCause/evidence as known deficiencies and shows both post-prompt samples' correlation baseline as pass", () => {
  const currentEvaluation = evaluateDatasetV4(loadRealDatasetV4());
  const comparison = compareEvaluationToBaselineV4(currentEvaluation, loadRealBaselineV4());
  const output = formatRegressionReportV4(comparison);

  assert.match(output, /QA Agent Regression Check — Baseline v4/);
  assert.match(output, /Status: UNCHANGED/);
  assert.match(output, /Known deficiencies:\n(.*\n)*\s+- experiment-41-correlation-necessary-grounding fabricatedEvidence/);
  assert.match(output, /Known deficiencies:\n(.*\n)*\s+- experiment-41-correlation-necessary-grounding rootCause/);
  assert.match(output, /Correlation baseline:\n(.*\n)*\s+- experiment-45-post-prompt-grounding-revalidation: construction=pass, transport=pass, reasoning=pass/);
  assert.match(output, /Correlation baseline:\n(.*\n)*\s+- experiment-47-post-prompt-grounding-revalidation: construction=pass, transport=pass, reasoning=pass/);
});
