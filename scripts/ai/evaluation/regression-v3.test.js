"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { compareEvaluationToBaselineV3, formatRegressionReportV3, run } = require("./regression-v3");
const { evaluateDatasetV3 } = require("./scoring-v3");

const DATASET_V3_PATH = path.join(__dirname, "dataset-v3.json");
const BASELINE_V3_PATH = path.join(__dirname, "baseline-v3.json");

function loadRealDatasetV3() {
  return JSON.parse(fs.readFileSync(DATASET_V3_PATH, "utf8"));
}

function loadRealBaselineV3() {
  return JSON.parse(fs.readFileSync(BASELINE_V3_PATH, "utf8"));
}

// Minimal synthetic sample matching the shape scoring-v3.js's
// evaluateDatasetV3() actually returns per sample.
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
      evidence: "pass",
      recommendedFix: "pass",
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
    correlationConstruction: overrides.correlationConstruction || "not_applicable",
    correlationTransport: overrides.correlationTransport || "not_applicable",
    correlationReasoning: overrides.correlationReasoning || "not_applicable",
  };
}

// A 7-sample synthetic baseline mirroring the real Baseline v3's shape (4
// not-applicable + A/B applicable-with-partial-reasoning + #41
// applicable-with-fail-reasoning-and-fabricatedEvidence), so per-test
// overrides read as "change just this one thing."
function makeSyntheticBaseline(overrides = {}) {
  return {
    version: 1,
    datasetVersion: 3,
    samples: {
      "exp-2": makeBaselineSample({ classificationStatus: "fail", shouldRetryCorrect: false }),
      "exp-3": makeBaselineSample(),
      "exp-4": makeBaselineSample(),
      "exp-5": makeBaselineSample({ classificationStatus: "ambiguous" }),
      "exp-A": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
      "exp-B": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial" }),
      "exp-41": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: true }),
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
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: true }),
    ...overrides,
  };
  return { metrics: {}, samples: Object.values(samples) };
}

// 1. real Dataset v3 vs Baseline v3 -> UNCHANGED
test("real Dataset v3 vs real Baseline v3: status is UNCHANGED with 0 regressions, 0 improvements", () => {
  const currentEvaluation = evaluateDatasetV3(loadRealDatasetV3());
  const comparison = compareEvaluationToBaselineV3(currentEvaluation, loadRealBaselineV3());

  assert.equal(comparison.status, "UNCHANGED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(comparison.summary.improvements, 0);

  const exp41 = comparison.samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");
  assert.equal(exp41.fabricatedEvidence.change, "unchanged");
  assert.equal(exp41.fabricatedEvidence.baseline, true);
  assert.equal(exp41.correlationReasoning.change, "unchanged");
  assert.equal(exp41.correlationReasoning.baseline, "fail");
});

// 2. #41 fabricatedEvidence true -> false, no other regressions -> IMPROVED
test("Experiment #41 fabricatedEvidence: true -> false with no regressions yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: false }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);

  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(comparison.samples.find((s) => s.id === "exp-41").fabricatedEvidence.change, "improvement");
});

// 3. #41 fabricatedEvidence true -> false AND rootCause fail -> pass:
// rootCause is NOT regression-protected today (known limitation) - this
// test documents that fact rather than inventing protection for it. The
// top-level status must still reflect only the dimensions that ARE
// protected (fabricatedEvidence here), and rootCause's change must not
// appear anywhere in the comparison output.
test("Experiment #41: fabricatedEvidence improves and rootCause is curated better, but rootCause itself is not a regression-tracked dimension", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", {
      correlationConstruction: "pass",
      correlationTransport: "pass",
      correlationReasoning: "fail",
      fabricatedEvidence: false,
      rootCause: "pass",
    }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);

  assert.equal(comparison.status, "IMPROVED");
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");
  assert.equal(exp41.fabricatedEvidence.change, "improvement");
  // rootCause has no comparison field in the output at all - confirming it
  // is genuinely untracked, not silently tracked-but-unchanged.
  assert.equal(exp41.rootCause, undefined);
});

// 4. #41 fabricatedEvidence true -> false BUT classification pass -> fail -> REGRESSED
test("Experiment #41: fabricatedEvidence improves but classification regresses - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { classificationStatus: "incorrect", correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: false }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);

  assert.equal(comparison.status, "REGRESSED");
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");
  assert.equal(exp41.fabricatedEvidence.change, "improvement");
  assert.equal(exp41.classification.change, "regression");
});

// 5. #41 fabricatedEvidence true -> false BUT shouldCreateBugCorrect true -> false -> REGRESSED
test("Experiment #41: fabricatedEvidence improves but shouldCreateBug regresses - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { shouldCreateBugCorrect: false, correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: false }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);

  assert.equal(comparison.status, "REGRESSED");
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");
  assert.equal(exp41.fabricatedEvidence.change, "improvement");
  assert.equal(exp41.shouldCreateBug.change, "regression");
});

// 6. #41 correlationReasoning fail -> partial -> IMPROVED (correlation ordering supports this)
test("Experiment #41 correlationReasoning: fail -> partial yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "partial", fabricatedEvidence: true }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);

  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-41").correlationReasoning.change, "improvement");
});

// 7. #41 correlationReasoning fail -> pass -> IMPROVED
test("Experiment #41 correlationReasoning: fail -> pass yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", fabricatedEvidence: true }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);

  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-41").correlationReasoning.change, "improvement");
});

// 8. fabricatedEvidence improvement on #41 + correlation regression on another sample -> REGRESSED
test("Experiment #41 fabricatedEvidence improvement plus a correlation regression on another sample still yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: false }),
    "exp-A": makeCurrentSample("exp-A", { correlationConstruction: "partial", correlationTransport: "pass", correlationReasoning: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);

  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-41").fabricatedEvidence.change, "improvement");
  assert.equal(comparison.samples.find((s) => s.id === "exp-A").correlationConstruction.change, "regression");
});

// 9. aggregate fabricatedEvidence counts unchanged but per-sample regression -> REGRESSED
test("fabricatedEvidence aggregate masking: one sample regresses while Experiment #41 improves - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: false }),
    "exp-3": makeCurrentSample("exp-3", { fabricatedEvidence: true }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);

  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-41").fabricatedEvidence.change, "improvement");
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").fabricatedEvidence.change, "regression");
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(comparison.summary.regressions, 1);
});

test("known Experiment #2 classification deficiency (fail -> fail) is unchanged, not a new regression", () => {
  const currentEvaluation = evaluateDatasetV3(loadRealDatasetV3());
  const comparison = compareEvaluationToBaselineV3(currentEvaluation, loadRealBaselineV3());
  const exp2 = comparison.samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(exp2.classification.baseline, "fail");
  assert.equal(exp2.classification.current, "fail");
  assert.equal(exp2.classification.change, "unchanged");
});

// Experiment #5's ambiguous classification semantics remain unchanged.
test("Experiment #5 ambiguous classification remains informational, does not drive top-level status", () => {
  const currentEvaluation = evaluateDatasetV3(loadRealDatasetV3());
  const comparison = compareEvaluationToBaselineV3(currentEvaluation, loadRealBaselineV3());
  const exp5 = comparison.samples.find((s) => s.id === "experiment-5-real-flaky-test");
  assert.equal(exp5.classification.change, "informational");
});

test("a sample-set mismatch is reported as BASELINE_MISMATCH, not silently ignored", () => {
  const baseline = makeSyntheticBaseline();
  const currentSamples = makeSyntheticCurrentEvaluation().samples.filter((s) => s.id !== "exp-41");
  const comparison = compareEvaluationToBaselineV3({ metrics: {}, samples: currentSamples }, baseline);
  assert.equal(comparison.status, "BASELINE_MISMATCH");
  assert.equal(comparison.summary, null);
  assert.ok(comparison.errors.some((e) => e.includes('"exp-41"')));
});

test("offline guarantee: regression-v3.js does not actually use AI providers, credentials, or network calls", () => {
  const source = fs.readFileSync(path.join(__dirname, "regression-v3.js"), "utf8");
  const forbiddenPatterns = [
    /require\([^)]*providers/,
    /createProvider\s*\(/,
    /process\.env\.AI_API_KEY/,
    /process\.env\.GROQ_API_KEY/,
    /\bfetch\s*\(/,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(source), `expected no match for ${pattern} in regression-v3.js`);
  }
});

test("run(): the real dataset-v3.json vs the real baseline-v3.json returns exit code 0 with status UNCHANGED", () => {
  const result = run(DATASET_V3_PATH, BASELINE_V3_PATH);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Status: UNCHANGED/);
});

test("formatRegressionReportV3: reports Experiment #41's fabricatedEvidence as a known deficiency and shows its correlation baseline", () => {
  const currentEvaluation = evaluateDatasetV3(loadRealDatasetV3());
  const comparison = compareEvaluationToBaselineV3(currentEvaluation, loadRealBaselineV3());
  const output = formatRegressionReportV3(comparison);

  assert.match(output, /QA Agent Regression Check — Baseline v3/);
  assert.match(output, /Status: UNCHANGED/);
  assert.match(output, /Known deficiencies:\n(.*\n)*\s+- experiment-41-correlation-necessary-grounding fabricatedEvidence/);
  assert.match(output, /Correlation baseline:\n(.*\n)*\s+- experiment-41-correlation-necessary-grounding: construction=pass, transport=pass, reasoning=fail/);
});
