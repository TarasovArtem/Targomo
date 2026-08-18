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

// 3. Roadmap #12: rootCause is now regression-protected. #41
// fabricatedEvidence true -> false AND rootCause fail -> pass are both
// improvements on the same sample - status must still be IMPROVED, and
// rootCause's change must now appear in the comparison output (the exact
// opposite of the old known-limitation this test used to document).
test("Experiment #41: fabricatedEvidence and rootCause both improve on the same sample - still IMPROVED, and rootCause is now tracked", () => {
  const baseline = makeSyntheticBaseline({
    "exp-41": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", fabricatedEvidence: true, rootCause: "fail" }),
  });
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
  assert.equal(exp41.rootCause.change, "improvement");
  assert.equal(exp41.rootCause.baseline, "fail");
  assert.equal(exp41.rootCause.current, "pass");
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
  // Roadmap #12: rootCause/evidence are now tracked, and Experiment #41's
  // frozen fail/fail state must show up as a known deficiency too, not a
  // silent gap. recommendedFix stays "partial" (not "fail"), so it is
  // deliberately not expected here - a partial baseline was never flagged
  // as a deficiency for any existing dimension either.
  assert.match(output, /Known deficiencies:\n(.*\n)*\s+- experiment-41-correlation-necessary-grounding rootCause/);
  assert.match(output, /Known deficiencies:\n(.*\n)*\s+- experiment-41-correlation-necessary-grounding evidence/);
  assert.match(output, /Correlation baseline:\n(.*\n)*\s+- experiment-41-correlation-necessary-grounding: construction=pass, transport=pass, reasoning=fail/);
});

// ============================================================
// Roadmap #12 — Qualitative Regression Protection
// ============================================================

// Step 16: transition tests for each of the three new dimensions, using the
// same fail<partial<pass ordering already established for correlation
// quality. Table-driven, since this is nine transitions x three dimensions.
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
      const baseline = makeSyntheticBaseline({ "exp-41": makeBaselineSample({ [dimension]: from }) });
      const current = makeSyntheticCurrentEvaluation({
        "exp-41": makeCurrentSample("exp-41", { [dimension]: to }),
      });
      const comparison = compareEvaluationToBaselineV3(current, baseline);
      const sample = comparison.samples.find((s) => s.id === "exp-41");
      assert.equal(sample[dimension].change, expected);

      const expectedStatus = expected === "regression" ? "REGRESSED" : expected === "improvement" ? "IMPROVED" : "UNCHANGED";
      assert.equal(comparison.status, expectedStatus);
    });
  }
}

// Step 17: mandatory mixed-regression scenarios. Each pairs an improving
// dimension with a regressing one (sometimes on different dimensions,
// sometimes different samples) - the top-level status must be REGRESSED in
// every case, since any single regression anywhere outweighs any number of
// simultaneous improvements.

// A. fabricatedEvidence true -> false, recommendedFix pass -> fail => REGRESSED
test("mixed A: fabricatedEvidence improves while recommendedFix regresses on the same sample - REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-41": makeBaselineSample({ fabricatedEvidence: true, recommendedFix: "pass" }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { fabricatedEvidence: false, recommendedFix: "fail" }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");
  assert.equal(exp41.fabricatedEvidence.change, "improvement");
  assert.equal(exp41.recommendedFix.change, "regression");
});

// B. correlationReasoning fail -> pass, evidence pass -> partial => REGRESSED
test("mixed B: correlationReasoning improves while evidence regresses on the same sample - REGRESSED", () => {
  const baseline = makeSyntheticBaseline({
    "exp-41": makeBaselineSample({ correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "fail", evidence: "pass" }),
  });
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass", evidence: "partial" }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");
  assert.equal(exp41.correlationReasoning.change, "improvement");
  assert.equal(exp41.evidence.change, "regression");
});

// C. rootCause fail -> pass, classification correct -> incorrect => REGRESSED
test("mixed C: rootCause improves while classification regresses on the same sample - REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-41": makeBaselineSample({ rootCause: "fail" }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { rootCause: "pass", classificationStatus: "incorrect" }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");
  assert.equal(exp41.rootCause.change, "improvement");
  assert.equal(exp41.classification.change, "regression");
});

// D. evidence fail -> pass, shouldCreateBug correct -> incorrect => REGRESSED
test("mixed D: evidence improves while shouldCreateBug regresses on the same sample - REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-41": makeBaselineSample({ evidence: "fail" }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { evidence: "pass", shouldCreateBugCorrect: false }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");
  assert.equal(exp41.evidence.change, "improvement");
  assert.equal(exp41.shouldCreateBug.change, "regression");
});

// E. recommendedFix partial -> pass, fabricatedEvidence false -> true => REGRESSED
test("mixed E: recommendedFix improves while fabricatedEvidence regresses on the same sample - REGRESSED", () => {
  const baseline = makeSyntheticBaseline({ "exp-41": makeBaselineSample({ recommendedFix: "partial", fabricatedEvidence: false }) });
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", { recommendedFix: "pass", fabricatedEvidence: true }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");
  assert.equal(exp41.recommendedFix.change, "improvement");
  assert.equal(exp41.fabricatedEvidence.change, "regression");
});

// Step 18: aggregate masking. Sample A's rootCause regresses pass -> fail
// while Sample B's rootCause improves fail -> pass at the same time - the
// raw {pass, partial, fail, not_applicable} counts across the dataset are
// identical either way, but per-sample comparison must still catch A's
// regression rather than letting B's improvement cancel it out in a global
// count.
test("aggregate masking: rootCause regresses on one sample while it improves on another - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline({
    "exp-3": makeBaselineSample({ rootCause: "pass" }),
    "exp-4": makeBaselineSample({ rootCause: "fail" }),
  });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { rootCause: "fail" }),
    "exp-4": makeCurrentSample("exp-4", { rootCause: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").rootCause.change, "regression");
  assert.equal(comparison.samples.find((s) => s.id === "exp-4").rootCause.change, "improvement");
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(comparison.summary.regressions, 1);
});

// Repeated for evidence, per Step 18's "repeat for evidence or
// recommendedFix if practical."
test("aggregate masking: evidence regresses on one sample while it improves on another - still REGRESSED", () => {
  const baseline = makeSyntheticBaseline({
    "exp-3": makeBaselineSample({ evidence: "pass" }),
    "exp-4": makeBaselineSample({ evidence: "fail" }),
  });
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { evidence: "fail" }),
    "exp-4": makeCurrentSample("exp-4", { evidence: "pass" }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").evidence.change, "regression");
  assert.equal(comparison.samples.find((s) => s.id === "exp-4").evidence.change, "improvement");
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(comparison.summary.regressions, 1);
});

// Step 19: known deficiency behavior using the REAL Dataset v3/Baseline v3 -
// Experiment #41's frozen rootCause=fail/evidence=fail/recommendedFix=partial
// must remain UNCHANGED (not a new regression) when baseline and current are
// identical, exactly like the existing classification/fabricatedEvidence
// known-deficiency tests above.
test("Experiment #41's frozen rootCause/evidence/recommendedFix stay unchanged (known deficiencies), never a new regression", () => {
  const currentEvaluation = evaluateDatasetV3(loadRealDatasetV3());
  const comparison = compareEvaluationToBaselineV3(currentEvaluation, loadRealBaselineV3());
  const exp41 = comparison.samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");

  assert.equal(exp41.rootCause.change, "unchanged");
  assert.equal(exp41.rootCause.baseline, "fail");
  assert.equal(exp41.evidence.change, "unchanged");
  assert.equal(exp41.evidence.baseline, "fail");
  assert.equal(exp41.recommendedFix.change, "unchanged");
  assert.equal(exp41.recommendedFix.baseline, "partial");

  assert.equal(comparison.status, "UNCHANGED");
  assert.equal(comparison.summary.regressions, 0);
});

// Step 20: TEST FIXTURE ONLY - simulates the successful Part 3B direction
// (the real controlled re-validation result recorded in PR #45 / the
// evidence-grounding-revalidation experiment) entirely in synthetic data.
// This does NOT write anything into Dataset v3/Baseline v3 - it only proves
// the regression comparator would correctly recognize that full direction
// as IMPROVED, with zero regressions, if it were ever frozen.
test("Part 3B success direction, as a synthetic fixture only: Experiment #41 fully improved yields IMPROVED with zero regressions", () => {
  const baseline = makeSyntheticBaseline({
    "exp-41": makeBaselineSample({
      correlationConstruction: "pass",
      correlationTransport: "pass",
      correlationReasoning: "fail",
      fabricatedEvidence: true,
      rootCause: "fail",
      evidence: "fail",
      recommendedFix: "partial",
    }),
  });
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", {
      // classification/shouldRetry/shouldCreateBug stay at their defaults
      // (correct/true/true) - ground truth (TEST_BUG/false/false) preserved.
      correlationConstruction: "pass",
      correlationTransport: "pass",
      correlationReasoning: "pass",
      fabricatedEvidence: false,
      rootCause: "pass",
      evidence: "pass",
      recommendedFix: "pass",
    }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");

  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(exp41.classification.change, "unchanged");
  assert.equal(exp41.shouldRetry.change, "unchanged");
  assert.equal(exp41.shouldCreateBug.change, "unchanged");
  assert.equal(exp41.fabricatedEvidence.change, "improvement");
  assert.equal(exp41.rootCause.change, "improvement");
  assert.equal(exp41.evidence.change, "improvement");
  assert.equal(exp41.recommendedFix.change, "improvement");
  assert.equal(exp41.correlationReasoning.change, "improvement");
});

// Step 21: same fixture as Step 20, but with recommendedFix regressing
// (partial -> fail) instead of improving - proves a qualitative regression
// is never masked by every other dimension improving at once.
test("Part 3B success direction, but recommendedFix regresses instead of improving: REGRESSED, not masked by the other improvements", () => {
  const baseline = makeSyntheticBaseline({
    "exp-41": makeBaselineSample({
      correlationConstruction: "pass",
      correlationTransport: "pass",
      correlationReasoning: "fail",
      fabricatedEvidence: true,
      rootCause: "fail",
      evidence: "fail",
      recommendedFix: "partial",
    }),
  });
  const current = makeSyntheticCurrentEvaluation({
    "exp-41": makeCurrentSample("exp-41", {
      correlationConstruction: "pass",
      correlationTransport: "pass",
      correlationReasoning: "pass",
      fabricatedEvidence: false,
      rootCause: "pass",
      evidence: "pass",
      recommendedFix: "fail", // regression: partial -> fail
    }),
  });
  const comparison = compareEvaluationToBaselineV3(current, baseline);
  const exp41 = comparison.samples.find((s) => s.id === "exp-41");

  assert.equal(comparison.status, "REGRESSED");
  assert.equal(exp41.fabricatedEvidence.change, "improvement");
  assert.equal(exp41.rootCause.change, "improvement");
  assert.equal(exp41.evidence.change, "improvement");
  assert.equal(exp41.correlationReasoning.change, "improvement");
  assert.equal(exp41.recommendedFix.change, "regression");
});
