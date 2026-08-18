"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { compareEvaluationToBaselineV2, formatRegressionReportV2, run } = require("./regression-v2");
const { evaluateDatasetV2 } = require("./scoring-v2");

const DATASET_V2_PATH = path.join(__dirname, "dataset-v2.json");
const BASELINE_V2_PATH = path.join(__dirname, "baseline-v2.json");

function loadRealDatasetV2() {
  return JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf8"));
}

function loadRealBaselineV2() {
  return JSON.parse(fs.readFileSync(BASELINE_V2_PATH, "utf8"));
}

// Minimal synthetic sample matching the shape scoring-v2.js's
// evaluateDatasetV2() actually returns per sample.
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

// A 6-sample synthetic baseline mirroring the real Baseline v2's shape (4
// not-applicable + A/B applicable-with-partial-reasoning), so per-test
// overrides read as "change just this one thing."
function makeSyntheticBaseline(overrides = {}) {
  return {
    version: 1,
    datasetVersion: 2,
    samples: {
      "exp-2": makeBaselineSample({ classificationStatus: "fail", shouldRetryCorrect: false }),
      "exp-3": makeBaselineSample(),
      "exp-4": makeBaselineSample(),
      "exp-5": makeBaselineSample({ classificationStatus: "ambiguous" }),
      "exp-A": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
      "exp-B": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
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
    ...overrides,
  };
  return { metrics: {}, samples: Object.values(samples) };
}

// 1. real Dataset v2 vs Baseline v2 -> UNCHANGED
test("real Dataset v2 vs real Baseline v2: status is UNCHANGED with 0 regressions, 0 improvements", () => {
  const currentEvaluation = evaluateDatasetV2(loadRealDatasetV2());
  const comparison = compareEvaluationToBaselineV2(currentEvaluation, loadRealBaselineV2());

  assert.equal(comparison.status, "UNCHANGED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(comparison.summary.improvements, 0);

  const sampleA = comparison.samples.find((s) => s.id === "experiment-A-multi-browser-same-signature");
  assert.equal(sampleA.correlationReasoning.current, "partial");
  const sampleB = comparison.samples.find((s) => s.id === "experiment-B-multi-browser-different-signatures");
  assert.equal(sampleB.correlationReasoning.current, "partial");

  // Every real v2 sample's fabricatedEvidence stays false -> false.
  for (const sample of comparison.samples) {
    assert.equal(sample.fabricatedEvidence.change, "unchanged", `${sample.id}: fabricatedEvidence`);
    assert.equal(sample.fabricatedEvidence.baseline, false, `${sample.id}: baseline fabricatedEvidence`);
  }
});

test("Scenario A fabricatedEvidence false -> true yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial", fabricatedEvidence: true }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-A").fabricatedEvidence.change, "regression");
});

test("Scenario B fabricatedEvidence false -> true yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-B": makeCurrentSample("exp-B", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial", fabricatedEvidence: true }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-B").fabricatedEvidence.change, "regression");
});

test("fabricatedEvidence true -> false yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline({ "exp-3": makeBaselineSample({ fabricatedEvidence: true }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { fabricatedEvidence: false }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").fabricatedEvidence.change, "improvement");
});

test("correlationReasoning partial -> pass together with fabricatedEvidence false -> true on another sample still yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
    "exp-B": makeCurrentSample("exp-B", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial", fabricatedEvidence: true }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-A").correlationReasoning.change, "improvement");
  assert.equal(comparison.samples.find((s) => s.id === "exp-B").fabricatedEvidence.change, "regression");
});

test("fabricatedEvidence improvement plus a classification regression on another sample still yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-3": makeBaselineSample({ fabricatedEvidence: true }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { fabricatedEvidence: false }),
    "exp-4": makeCurrentSample("exp-4", { classificationStatus: "incorrect" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").fabricatedEvidence.change, "improvement");
  assert.equal(comparison.samples.find((s) => s.id === "exp-4").classification.change, "regression");
});

test("fabricatedEvidence improvement plus a shouldCreateBug regression on another sample still yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-3": makeBaselineSample({ fabricatedEvidence: true }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { fabricatedEvidence: false }),
    "exp-4": makeCurrentSample("exp-4", { shouldCreateBugCorrect: false }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").fabricatedEvidence.change, "improvement");
  assert.equal(comparison.samples.find((s) => s.id === "exp-4").shouldCreateBug.change, "regression");
});

// Mandatory masking test: exp-3 worsens (false->true) while exp-4 improves
// (true->false) at the same time - aggregate true/false counts are
// unchanged, but per-sample comparison must still catch exp-3's regression.
test("fabricatedEvidence aggregate masking: one sample regresses while another improves - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-4": makeBaselineSample({ fabricatedEvidence: true }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { fabricatedEvidence: true }),
    "exp-4": makeCurrentSample("exp-4", { fabricatedEvidence: false }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").fabricatedEvidence.change, "regression");
  assert.equal(comparison.samples.find((s) => s.id === "exp-4").fabricatedEvidence.change, "improvement");
});

// 2/3. Scenario A/B correlationReasoning partial -> pass = IMPROVED
test("Scenario A correlationReasoning partial -> pass yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-A").correlationReasoning.change, "improvement");
});

test("Scenario B correlationReasoning partial -> pass yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-B": makeCurrentSample("exp-B", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-B").correlationReasoning.change, "improvement");
});

// 4. partial -> fail = REGRESSED
test("correlationReasoning partial -> fail yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-A").correlationReasoning.change, "regression");
});

// 5. pass -> partial = REGRESSED
test("correlationConstruction pass -> partial yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "partial", correlationTransport: "pass", correlationReasoning: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-A").correlationConstruction.change, "regression");
});

// 6. fail -> partial = IMPROVEMENT
test("correlationReasoning fail -> partial yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline({
    "exp-A": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail" }),
  });
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-A").correlationReasoning.change, "improvement");
});

// 7. correlation improvement + classification regression -> REGRESSED
test("correlation reasoning improves on one sample while classification regresses on another -> REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
    "exp-3": makeCurrentSample("exp-3", { classificationStatus: "incorrect" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.summary.improvements, 1);
  assert.ok(comparison.summary.regressions >= 1);
});

// 8. correlation improvement + shouldCreateBug regression -> REGRESSED
test("correlation reasoning improves while shouldCreateBug regresses (even on the same sample) -> REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", shouldCreateBugCorrect: false }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const sampleA = comparison.samples.find((s) => s.id === "exp-A");
  assert.equal(sampleA.correlationReasoning.change, "improvement");
  assert.equal(sampleA.shouldCreateBug.change, "regression");
});

// 9. known v1 Experiment #2 classification fail remains fail -> known deficiency / unchanged
test("known Experiment #2 classification deficiency (fail -> fail) is unchanged, not a new regression", () => {
  const currentEvaluation = evaluateDatasetV2(loadRealDatasetV2());
  const comparison = compareEvaluationToBaselineV2(currentEvaluation, loadRealBaselineV2());
  const exp2 = comparison.samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(exp2.classification.baseline, "fail");
  assert.equal(exp2.classification.current, "fail");
  assert.equal(exp2.classification.change, "unchanged");
});

// 10. Experiment #5 ambiguous classification remains informational
test("Experiment #5 ambiguous classification remains informational, does not drive top-level status", () => {
  const currentEvaluation = evaluateDatasetV2(loadRealDatasetV2());
  const comparison = compareEvaluationToBaselineV2(currentEvaluation, loadRealBaselineV2());
  const exp5 = comparison.samples.find((s) => s.id === "experiment-5-real-flaky-test");
  assert.equal(exp5.classification.change, "informational");
});

// 11. sample set mismatch -> explicit error
test("a sample-set mismatch is reported as BASELINE_MISMATCH, not silently ignored", () => {
  const baseline = makeSyntheticBaseline();
  const currentSamples = makeSyntheticCurrentEvaluation().samples.filter((s) => s.id !== "exp-B");
  const comparison = compareEvaluationToBaselineV2({ metrics: {}, samples: currentSamples }, baseline);
  assert.equal(comparison.status, "BASELINE_MISMATCH");
  assert.equal(comparison.summary, null);
  assert.ok(comparison.errors.some((e) => e.includes('"exp-B"')));
});

// 12. same aggregate classification accuracy but per-sample regression -> REGRESSED
test("simultaneous improvement + regression with unchanged aggregate classification accuracy still yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-2": makeCurrentSample("exp-2", { classificationStatus: "correct", shouldRetryCorrect: false }), // fail -> pass (improvement)
    "exp-3": makeCurrentSample("exp-3", { classificationStatus: "incorrect" }), // pass -> fail (regression)
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.summary.improvements >= 1, true);
  assert.equal(comparison.summary.regressions >= 1, true);
});

// 13. correlation aggregate counts unchanged but per-sample correlation regression -> REGRESSED
test("correlation aggregate counts stay the same shape but a per-sample correlation regression still yields REGRESSED", () => {
  // Swap: exp-A regresses pass->partial while exp-B simultaneously improves
  // partial->pass, so the raw {pass,partial,fail,not_applicable} counts
  // across the dataset are identical to baseline - but this must still be
  // detected as a real regression.
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "partial", correlationTransport: "pass", correlationReasoning: "partial" }),
    "exp-B": makeCurrentSample("exp-B", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
});

// 14. offline guarantee
test("offline guarantee: regression-v2.js does not actually use AI providers, credentials, or network calls", () => {
  const source = fs.readFileSync(path.join(__dirname, "regression-v2.js"), "utf8");
  const forbiddenPatterns = [
    /require\([^)]*providers/,
    /createProvider\s*\(/,
    /process\.env\.AI_API_KEY/,
    /process\.env\.GROQ_API_KEY/,
    /\bfetch\s*\(/,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(source), `expected no match for ${pattern} in regression-v2.js`);
  }
});

// Extra: not_applicable -> not_applicable stays unchanged; applicability
// itself changing is informational, never a silent quality regression.
test("not_applicable -> not_applicable is unchanged; a sample gaining applicability is informational, not a quality regression", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-2": makeCurrentSample("exp-2", { classificationStatus: "incorrect", shouldRetryCorrect: false, correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  const exp2 = comparison.samples.find((s) => s.id === "exp-2");
  assert.equal(exp2.correlationConstruction.change, "informational");
  // The known classification/shouldRetry deficiencies stay unchanged, so
  // this synthetic case should not itself introduce a regression.
  assert.notEqual(comparison.status, "REGRESSED");
});

test("run(): the real dataset-v2.json vs the real baseline-v2.json returns exit code 0 with status UNCHANGED", () => {
  const result = run(DATASET_V2_PATH, BASELINE_V2_PATH);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Status: UNCHANGED/);
});

test("formatRegressionReportV2: shows the correlation baseline for applicable samples only", () => {
  const currentEvaluation = evaluateDatasetV2(loadRealDatasetV2());
  const comparison = compareEvaluationToBaselineV2(currentEvaluation, loadRealBaselineV2());
  const output = formatRegressionReportV2(comparison);

  assert.match(output, /Correlation baseline:/);
  assert.match(output, /experiment-A-multi-browser-same-signature: construction=pass, transport=pass, reasoning=partial/);
  assert.match(output, /experiment-B-multi-browser-different-signatures: construction=pass, transport=pass, reasoning=partial/);
});

// ============================================================
// Roadmap #12 — Qualitative Regression Protection
// ============================================================

const QUALITATIVE_DIMENSIONS = ["rootCause", "evidence", "recommendedFix"];
const TRANSITIONS = [
  { from: "fail", to: "partial", expected: "improvement" },
  { from: "fail", to: "pass", expected: "improvement" },
  { from: "partial", to: "pass", expected: "improvement" },
  { from: "pass", to: "partial", expected: "regression" },
  { from: "pass", to: "fail", expected: "regression" },
  { from: "partial", to: "fail", expected: "regression" },
  { from: "fail", to: "fail", expected: "unchanged" },
  { from: "partial", to: "partial", expected: "unchanged" },
  { from: "pass", to: "pass", expected: "unchanged" },
];

for (const dimension of QUALITATIVE_DIMENSIONS) {
  for (const { from, to, expected } of TRANSITIONS) {
    test(`${dimension}: ${from} -> ${to} yields ${expected}`, () => {
      const baseline = makeSyntheticBaseline({ "exp-A": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial", [dimension]: from }) });
      const current = makeSyntheticCurrentEvaluation({
        "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial", [dimension]: to }),
      });
      const comparison = compareEvaluationToBaselineV2(current, baseline);
      const sample = comparison.samples.find((s) => s.id === "exp-A");
      assert.equal(sample[dimension].change, expected);

      const expectedStatus = expected === "regression" ? "REGRESSED" : expected === "improvement" ? "IMPROVED" : "UNCHANGED";
      assert.equal(comparison.status, expectedStatus);
    });
  }
}

test("mixed: fabricatedEvidence improves while recommendedFix regresses on the same sample - REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-3": makeBaselineSample({ fabricatedEvidence: true, recommendedFix: "pass" }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { fabricatedEvidence: false, recommendedFix: "fail" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const exp3 = comparison.samples.find((s) => s.id === "exp-3");
  assert.equal(exp3.fabricatedEvidence.change, "improvement");
  assert.equal(exp3.recommendedFix.change, "regression");
});

test("mixed: rootCause improves while classification regresses on the same sample - REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-3": makeBaselineSample({ rootCause: "fail" }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { rootCause: "pass", classificationStatus: "incorrect" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const exp3 = comparison.samples.find((s) => s.id === "exp-3");
  assert.equal(exp3.rootCause.change, "improvement");
  assert.equal(exp3.classification.change, "regression");
});

test("mixed: evidence improves while shouldCreateBug regresses on the same sample - REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-3": makeBaselineSample({ evidence: "fail" }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { evidence: "pass", shouldCreateBugCorrect: false }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const exp3 = comparison.samples.find((s) => s.id === "exp-3");
  assert.equal(exp3.evidence.change, "improvement");
  assert.equal(exp3.shouldCreateBug.change, "regression");
});

// Aggregate masking: exp-3's rootCause regresses pass -> fail while exp-4's
// improves fail -> pass at the same time - the raw counts are identical
// either way, but per-sample comparison must still catch exp-3's regression.
test("aggregate masking: rootCause regresses on one sample while it improves on another - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline({
    "exp-3": makeBaselineSample({ rootCause: "pass" }),
    "exp-4": makeBaselineSample({ rootCause: "fail" }),
  });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { rootCause: "fail" }),
    "exp-4": makeCurrentSample("exp-4", { rootCause: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV2(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").rootCause.change, "regression");
  assert.equal(comparison.samples.find((s) => s.id === "exp-4").rootCause.change, "improvement");
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(comparison.summary.regressions, 1);
});

// Known deficiency: real Dataset v2/Baseline v2's experiment-2 recommendedFix
// is frozen at "fail" - must remain unchanged, never a fresh regression.
test("known Experiment #2 recommendedFix deficiency (fail -> fail) is unchanged, not a new regression", () => {
  const currentEvaluation = evaluateDatasetV2(loadRealDatasetV2());
  const comparison = compareEvaluationToBaselineV2(currentEvaluation, loadRealBaselineV2());
  const exp2 = comparison.samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(exp2.recommendedFix.change, "unchanged");
  assert.equal(exp2.recommendedFix.baseline, "fail");
  assert.equal(comparison.status, "UNCHANGED");
});
