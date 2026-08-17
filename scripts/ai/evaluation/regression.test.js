"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { compareEvaluationToBaseline, formatRegressionReport, run } = require("./regression");
const { evaluateDataset } = require("./scoring");

const DATASET_PATH = path.join(__dirname, "dataset.json");
const BASELINE_PATH = path.join(__dirname, "baseline-v1.json");

function loadRealDataset() {
  return JSON.parse(fs.readFileSync(DATASET_PATH, "utf8"));
}

function loadRealBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

// Builds a minimal synthetic "current evaluation" sample matching the shape
// scoring.js's evaluateDataset() actually returns per sample - only the
// fields compareEvaluationToBaseline() reads.
function makeCurrentSample(id, { classificationStatus = "correct", shouldRetryCorrect = true, shouldCreateBugCorrect = true } = {}) {
  return {
    id,
    isAmbiguous: classificationStatus === "ambiguous",
    classification: { status: classificationStatus, expected: "TEST_BUG", actual: classificationStatus === "incorrect" ? "FLAKY_TEST" : "TEST_BUG" },
    shouldRetry: { correct: shouldRetryCorrect, expected: true, actual: shouldRetryCorrect },
    shouldCreateBug: { correct: shouldCreateBugCorrect, expected: true, actual: shouldCreateBugCorrect },
    policyAdjusted: false,
    quality: { classification: "pass", rootCause: "pass", evidence: "pass", recommendedFix: "pass", historyUsage: "neutral", fabricatedEvidence: false },
  };
}

function makeBaselineSample({ classificationStatus = "pass", shouldRetryCorrect = true, shouldCreateBugCorrect = true } = {}) {
  return { classificationStatus, shouldRetryCorrect, shouldCreateBugCorrect };
}

// A 4-sample synthetic baseline that mirrors the real Baseline v1's shape
// (3 scorable + 1 ambiguous), so per-test overrides read like "change just
// this one thing" without repeating all 4 samples every time.
function makeSyntheticBaseline(overrides) {
  return {
    version: 1,
    datasetVersion: 1,
    samples: {
      "exp-2": makeBaselineSample({ classificationStatus: "fail", shouldRetryCorrect: false, shouldCreateBugCorrect: true }),
      "exp-3": makeBaselineSample({ classificationStatus: "pass", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
      "exp-4": makeBaselineSample({ classificationStatus: "pass", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
      "exp-5": makeBaselineSample({ classificationStatus: "ambiguous", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
      ...overrides,
    },
  };
}

// Baseline-equivalent current evaluation: matches makeSyntheticBaseline()'s
// default statuses exactly, so tests only need to override the one sample
// under test to produce a controlled single change.
function makeSyntheticCurrentEvaluation(overrides) {
  const samples = {
    "exp-2": makeCurrentSample("exp-2", { classificationStatus: "incorrect", shouldRetryCorrect: false, shouldCreateBugCorrect: true }),
    "exp-3": makeCurrentSample("exp-3", { classificationStatus: "correct", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
    "exp-4": makeCurrentSample("exp-4", { classificationStatus: "correct", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
    "exp-5": makeCurrentSample("exp-5", { classificationStatus: "ambiguous", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
    ...overrides,
  };
  return { metrics: {}, samples: Object.values(samples) };
}

test("real Dataset v1 vs real Baseline v1: status is UNCHANGED with 0 regressions, 0 improvements", () => {
  const currentEvaluation = evaluateDataset(loadRealDataset());
  const comparison = compareEvaluationToBaseline(currentEvaluation, loadRealBaseline());

  assert.equal(comparison.status, "UNCHANGED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(comparison.summary.improvements, 0);

  // The known experiment-2 deficiency must still be visible, just reported
  // as "unchanged" (a known deficiency), not silently dropped.
  const exp2 = comparison.samples.find((s) => s.id === "experiment-2-broken-selector");
  assert.equal(exp2.classification.change, "unchanged");
  assert.equal(exp2.classification.baseline, "fail");
  assert.equal(exp2.shouldRetry.change, "unchanged");
  assert.equal(exp2.shouldRetry.baselineCorrect, false);
});

test("fixing experiment-2 classification (fail -> pass) alone yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-2": makeCurrentSample("exp-2", { classificationStatus: "correct", shouldRetryCorrect: false, shouldCreateBugCorrect: true }),
  });
  const comparison = compareEvaluationToBaseline(current, baseline);

  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(comparison.samples.find((s) => s.id === "exp-2").classification.change, "improvement");
});

test("fixing experiment-2 shouldRetry (incorrect -> correct) alone yields IMPROVED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-2": makeCurrentSample("exp-2", { classificationStatus: "incorrect", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
  });
  const comparison = compareEvaluationToBaseline(current, baseline);

  assert.equal(comparison.status, "IMPROVED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(comparison.samples.find((s) => s.id === "exp-2").shouldRetry.change, "improvement");
});

test("regressing experiment-3 classification (pass -> fail) alone yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-3": makeCurrentSample("exp-3", { classificationStatus: "incorrect", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
  });
  const comparison = compareEvaluationToBaseline(current, baseline);

  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.summary.regressions, 1);
  assert.equal(comparison.samples.find((s) => s.id === "exp-3").classification.change, "regression");
});

// Mandatory: proves the comparator is not fooled by aggregate accuracy.
// experiment-2 improves and experiment-3 regresses at the same time, so
// strict classification accuracy stays 2/3 correct either way - but this
// MUST still report REGRESSED, because one previously-passing sample broke.
test("simultaneous improvement + regression with unchanged aggregate accuracy still yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-2": makeCurrentSample("exp-2", { classificationStatus: "correct", shouldRetryCorrect: false, shouldCreateBugCorrect: true }),
    "exp-3": makeCurrentSample("exp-3", { classificationStatus: "incorrect", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
  });
  const comparison = compareEvaluationToBaseline(current, baseline);

  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(comparison.summary.regressions, 1);
});

test("shouldCreateBug regression (baseline correct -> current incorrect) yields REGRESSED", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-4": makeCurrentSample("exp-4", { classificationStatus: "correct", shouldRetryCorrect: true, shouldCreateBugCorrect: false }),
  });
  const comparison = compareEvaluationToBaseline(current, baseline);

  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.summary.regressions, 1);
  assert.equal(comparison.samples.find((s) => s.id === "exp-4").shouldCreateBug.change, "regression");
});

test("an ambiguous sample's classification drift is informational only and does not change top-level status", () => {
  const baseline = makeSyntheticBaseline();
  // exp-5 stays "ambiguous" on both sides (dataset ambiguity metadata is
  // frozen), but its underlying actual/expected values could still drift -
  // the classification dimension must remain purely informational.
  const current = makeSyntheticCurrentEvaluation({
    "exp-5": makeCurrentSample("exp-5", { classificationStatus: "ambiguous", shouldRetryCorrect: true, shouldCreateBugCorrect: true }),
  });
  const comparison = compareEvaluationToBaseline(current, baseline);

  assert.equal(comparison.status, "UNCHANGED");
  assert.equal(comparison.samples.find((s) => s.id === "exp-5").classification.change, "informational");
});

test("an ambiguous sample's shouldCreateBug regression still yields REGRESSED (ambiguity does not bypass action safety)", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-5": makeCurrentSample("exp-5", { classificationStatus: "ambiguous", shouldRetryCorrect: true, shouldCreateBugCorrect: false }),
  });
  const comparison = compareEvaluationToBaseline(current, baseline);

  assert.equal(comparison.status, "REGRESSED");
  assert.equal(comparison.summary.regressions, 1);
  assert.equal(comparison.samples.find((s) => s.id === "exp-5").shouldCreateBug.change, "regression");
});

test("a sample-set mismatch (current missing a baseline sample) is reported as BASELINE_MISMATCH, not silently ignored", () => {
  const baseline = makeSyntheticBaseline();
  const currentSamples = makeSyntheticCurrentEvaluation().samples.filter((s) => s.id !== "exp-5");
  const comparison = compareEvaluationToBaseline({ metrics: {}, samples: currentSamples }, baseline);

  assert.equal(comparison.status, "BASELINE_MISMATCH");
  assert.equal(comparison.summary, null);
  assert.ok(comparison.errors.some((e) => e.includes('"exp-5"')));
});

test("a sample-set mismatch (current has an extra sample not in baseline) is reported as BASELINE_MISMATCH", () => {
  const baseline = makeSyntheticBaseline();
  const current = makeSyntheticCurrentEvaluation({
    "exp-6-new": makeCurrentSample("exp-6-new"),
  });
  const comparison = compareEvaluationToBaseline(current, baseline);

  assert.equal(comparison.status, "BASELINE_MISMATCH");
  assert.ok(comparison.errors.some((e) => e.includes('"exp-6-new"')));
});

test("formatRegressionReport: renders status, counts, known deficiencies, and ambiguous samples for the real baseline", () => {
  const currentEvaluation = evaluateDataset(loadRealDataset());
  const comparison = compareEvaluationToBaseline(currentEvaluation, loadRealBaseline());
  const output = formatRegressionReport(comparison);

  assert.match(output, /QA Agent Regression Check — Baseline v1/);
  assert.match(output, /Status: UNCHANGED/);
  assert.match(output, /Improvements:\n\s+0/);
  assert.match(output, /Regressions:\n\s+0/);
  assert.match(output, /Known deficiencies:\n\s+- experiment-2-broken-selector classification/);
  assert.match(output, /Ambiguous:\n\s+- experiment-5-real-flaky-test/);
});

test("run(): the real dataset.json vs the real baseline-v1.json returns exit code 0 with status UNCHANGED", () => {
  const result = run(DATASET_PATH, BASELINE_PATH);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Status: UNCHANGED/);
});

test("offline guarantee: regression.js does not actually use AI providers, credentials, or network calls", () => {
  const source = fs.readFileSync(path.join(__dirname, "regression.js"), "utf8");
  const forbiddenPatterns = [
    /require\([^)]*providers/,
    /createProvider\s*\(/,
    /process\.env\.AI_API_KEY/,
    /process\.env\.GROQ_API_KEY/,
    /\bfetch\s*\(/,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(source), `expected no match for ${pattern} in regression.js`);
  }
});
