"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { validateDatasetV5 } = require("./dataset-v5-schema");
const { validateBaselineV5 } = require("./baseline-v5-schema");
const { evaluateDatasetV5 } = require("./scoring-v5");
const {
  compareEvaluationToBaselineV5,
  compareQualityTernary,
  compareQualityTernaryOrNull,
  compareModelShouldCreateBugCorrect,
  run,
} = require("./regression-v5");

const DATASET_PATH = path.join(__dirname, "dataset-v5.json");
const BASELINE_PATH = path.join(__dirname, "baseline-v5.json");

function loadReal() {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, "utf8"));
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  return { dataset, baseline };
}

test("real dataset-v5.json and baseline-v5.json both validate", () => {
  const { dataset, baseline } = loadReal();
  assert.equal(validateDatasetV5(dataset).valid, true);
  assert.equal(validateBaselineV5(baseline).valid, true);
});

test("real dataset-v5.json against real baseline-v5.json is UNCHANGED (baseline mirrors current curation)", () => {
  const { dataset, baseline } = loadReal();
  const evaluation = evaluateDatasetV5(dataset);
  const comparison = compareEvaluationToBaselineV5(evaluation, baseline);
  assert.equal(comparison.status, "UNCHANGED");
  assert.equal(comparison.summary.regressions, 0);
  assert.equal(comparison.summary.improvements, 0);
});

test("known deficiency: K3's modelShouldCreateBugCorrect is baselined as false (model wrong), not silently upgraded to true", () => {
  const { baseline } = loadReal();
  assert.equal(baseline.samples["K3-cross-browser-differing-signatures"].modelShouldCreateBugCorrect, false);
});

test("modelShouldCreateBugCorrect true->false is a regression", () => {
  assert.equal(compareModelShouldCreateBugCorrect(true, false), "regression");
});

test("modelShouldCreateBugCorrect false->true is an improvement", () => {
  assert.equal(compareModelShouldCreateBugCorrect(false, true), "improvement");
});

test("modelShouldCreateBugCorrect null on either side is informational, never silently a regression or improvement", () => {
  assert.equal(compareModelShouldCreateBugCorrect(null, true), "informational");
  assert.equal(compareModelShouldCreateBugCorrect(false, null), "informational");
  assert.equal(compareModelShouldCreateBugCorrect(null, null), "unchanged");
});

test("inferenceQuality partial->pass is an improvement", () => {
  assert.equal(compareQualityTernaryOrNull("partial", "pass"), "improvement");
});

test("inferenceQuality pass->partial is a regression", () => {
  assert.equal(compareQualityTernaryOrNull("pass", "partial"), "regression");
});

test("inferenceQuality null (not_evaluated) is never treated as pass or silently equal to not_applicable", () => {
  assert.equal(compareQualityTernaryOrNull(null, "pass"), "informational");
  assert.equal(compareQualityTernaryOrNull("not_applicable", null), "informational");
  assert.equal(compareQualityTernaryOrNull(null, null), "unchanged");
  // not_applicable and a real value are also informational, never ordered.
  assert.equal(compareQualityTernaryOrNull("not_applicable", "pass"), "informational");
});

test("knowledgeGrounding pass->fail is a regression (mutation-style check on the shared ternary comparator)", () => {
  assert.equal(compareQualityTernary("pass", "fail"), "regression");
});

test("N/A values are outside PASS/PARTIAL/FAIL ordering: not_applicable vs not_applicable is unchanged, never compared to pass/fail", () => {
  assert.equal(compareQualityTernary("not_applicable", "not_applicable"), "unchanged");
  assert.equal(compareQualityTernary("not_applicable", "pass"), "informational");
  assert.equal(compareQualityTernary("fail", "not_applicable"), "informational");
});

test("one simultaneous regression dominates any number of simultaneous improvements (composite baseline mutation)", () => {
  const { dataset, baseline } = loadReal();
  const mutatedBaseline = JSON.parse(JSON.stringify(baseline));
  // Force one dimension worse than current (a regression) and one dimension
  // better than current (an improvement) on the same sample.
  mutatedBaseline.samples["K4-firefox-knowledge-vs-direct-evidence"].recommendedFix = "fail"; // current is "pass" -> improvement
  mutatedBaseline.samples["K1-relevant-timeout-knowledge"].rootCause = "fail"; // will be reset below; establishing baseline start
  // Now make the CURRENT evaluation worse on a different sample/dimension than baseline to force an actual regression.
  const currentDataset = JSON.parse(JSON.stringify(dataset));
  const k5 = currentDataset.samples.find((s) => s.id === "K5-zero-relevant-knowledge");
  k5.quality.evidence = "fail"; // baseline has "pass" -> regression
  const evaluation = evaluateDatasetV5(currentDataset);
  const comparison = compareEvaluationToBaselineV5(evaluation, mutatedBaseline);
  assert.equal(comparison.status, "REGRESSED");
  assert.ok(comparison.summary.improvements >= 1, "expected at least one improvement to be present alongside the regression");
  assert.ok(comparison.summary.regressions >= 1);
});

test("BASELINE_MISMATCH when sample sets differ", () => {
  const { dataset, baseline } = loadReal();
  const evaluation = evaluateDatasetV5(dataset);
  const mutatedBaseline = JSON.parse(JSON.stringify(baseline));
  delete mutatedBaseline.samples["K5-zero-relevant-knowledge"];
  const comparison = compareEvaluationToBaselineV5(evaluation, mutatedBaseline);
  assert.equal(comparison.status, "BASELINE_MISMATCH");
});

test("run(): CLI-level entry point returns exitCode 0 with UNCHANGED status for the real files", () => {
  const result = run(DATASET_PATH, BASELINE_PATH);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Status: UNCHANGED/);
});

test("MUTATION: temporarily corrupting K5's expected exact set to require a nonexistent unit is detected as a knowledgeSelectionCorrect regression, then restored", () => {
  const originalDataset = fs.readFileSync(DATASET_PATH, "utf8");
  const dataset = JSON.parse(originalDataset);
  const k5 = dataset.samples.find((s) => s.id === "K5-zero-relevant-knowledge");
  k5.knowledge.expectedExactSelectedUnitIds = ["unit-that-does-not-exist"];

  const tmpPath = path.join(os.tmpdir(), `dataset-v5-mutation-${process.pid}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(dataset));
  try {
    const evaluation = evaluateDatasetV5(dataset);
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const comparison = compareEvaluationToBaselineV5(evaluation, baseline);
    assert.equal(comparison.status, "REGRESSED");
    const k5Result = comparison.samples.find((s) => s.id === "K5-zero-relevant-knowledge");
    assert.equal(k5Result.knowledgeSelectionCorrect.change, "regression");
  } finally {
    fs.unlinkSync(tmpPath);
  }
  // Original on-disk file was never touched by this test.
  assert.equal(fs.readFileSync(DATASET_PATH, "utf8"), originalDataset);
});

test("MUTATION: temporarily worsening K1's inferenceQuality from partial to fail is detected as a regression, in-memory only", () => {
  const originalDataset = fs.readFileSync(DATASET_PATH, "utf8");
  const dataset = JSON.parse(originalDataset);
  const k1 = dataset.samples.find((s) => s.id === "K1-relevant-timeout-knowledge");
  assert.equal(k1.quality.inferenceQuality, "partial", "precondition: K1 must currently be curated as partial");
  k1.quality.inferenceQuality = "fail";

  const evaluation = evaluateDatasetV5(dataset);
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const comparison = compareEvaluationToBaselineV5(evaluation, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const k1Result = comparison.samples.find((s) => s.id === "K1-relevant-timeout-knowledge");
  assert.equal(k1Result.inferenceQuality.change, "regression");

  assert.equal(fs.readFileSync(DATASET_PATH, "utf8"), originalDataset);
});

test("MUTATION: knowledgeGrounding pass->fail on K3 is detected as a regression, in-memory only", () => {
  const originalDataset = fs.readFileSync(DATASET_PATH, "utf8");
  const dataset = JSON.parse(originalDataset);
  const k3 = dataset.samples.find((s) => s.id === "K3-cross-browser-differing-signatures");
  assert.equal(k3.quality.knowledgeGrounding, "pass", "precondition: K3 must currently be curated as pass");
  k3.quality.knowledgeGrounding = "fail";

  const evaluation = evaluateDatasetV5(dataset);
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const comparison = compareEvaluationToBaselineV5(evaluation, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const k3Result = comparison.samples.find((s) => s.id === "K3-cross-browser-differing-signatures");
  assert.equal(k3Result.knowledgeGrounding.change, "regression");

  assert.equal(fs.readFileSync(DATASET_PATH, "utf8"), originalDataset);
});

test("MUTATION: temporarily changing K3's baseline modelShouldCreateBugCorrect from false to true is detected the moment current reverts to false (round-trip sanity)", () => {
  const { dataset, baseline } = loadReal();
  const mutatedBaseline = JSON.parse(JSON.stringify(baseline));
  mutatedBaseline.samples["K3-cross-browser-differing-signatures"].modelShouldCreateBugCorrect = true;

  const evaluation = evaluateDatasetV5(dataset); // current (real) K3 sample still has originalShouldCreateBug=true -> modelShouldCreateBugCorrect=false
  const comparison = compareEvaluationToBaselineV5(evaluation, mutatedBaseline);
  assert.equal(comparison.status, "REGRESSED");
  const k3Result = comparison.samples.find((s) => s.id === "K3-cross-browser-differing-signatures");
  assert.equal(k3Result.modelShouldCreateBugCorrect.change, "regression");
  // baseline-v5.json on disk was never touched.
});

// --- Roadmap #16E.2.1: dedicated knowledgeUsage full-pipeline coverage ---
//
// The #16E.2 independent review found that knowledgeUsage is protected by
// the shared compareQualityTernary comparator (already proven generically,
// and specifically exercised for knowledgeGrounding above), but no test
// exercised a knowledgeUsage degradation through the FULL
// compareEvaluationToBaselineV5() pipeline. K1 is real-world PASS-curated
// knowledge usage (both the dataset sample and its frozen baseline record
// "pass"), making it the natural fixture: mutate only the in-memory CURRENT
// dataset copy, compare against the real, untouched, on-disk baseline.

test("MUTATION: K1's knowledgeUsage pass->partial is detected as a regression through the full compareEvaluationToBaselineV5 pipeline, in-memory only", () => {
  const originalDataset = fs.readFileSync(DATASET_PATH, "utf8");
  const dataset = JSON.parse(originalDataset);
  const k1 = dataset.samples.find((s) => s.id === "K1-relevant-timeout-knowledge");
  assert.equal(k1.quality.knowledgeUsage, "pass", "precondition: K1 must currently be curated as pass");
  k1.quality.knowledgeUsage = "partial";

  const evaluation = evaluateDatasetV5(dataset);
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const comparison = compareEvaluationToBaselineV5(evaluation, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const k1Result = comparison.samples.find((s) => s.id === "K1-relevant-timeout-knowledge");
  assert.equal(k1Result.knowledgeUsage.change, "regression");

  assert.equal(fs.readFileSync(DATASET_PATH, "utf8"), originalDataset);
});

test("MUTATION: K1's knowledgeUsage pass->fail is also detected as a regression through the full pipeline, in-memory only", () => {
  const originalDataset = fs.readFileSync(DATASET_PATH, "utf8");
  const dataset = JSON.parse(originalDataset);
  const k1 = dataset.samples.find((s) => s.id === "K1-relevant-timeout-knowledge");
  k1.quality.knowledgeUsage = "fail";

  const evaluation = evaluateDatasetV5(dataset);
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const comparison = compareEvaluationToBaselineV5(evaluation, baseline);
  assert.equal(comparison.status, "REGRESSED");
  const k1Result = comparison.samples.find((s) => s.id === "K1-relevant-timeout-knowledge");
  assert.equal(k1Result.knowledgeUsage.change, "regression");

  assert.equal(fs.readFileSync(DATASET_PATH, "utf8"), originalDataset);
});

test("MUTATION: knowledgeUsage partial->pass is an improvement through the full pipeline (baseline mutated to partial, current stays at K1's real pass)", () => {
  const { dataset, baseline } = loadReal();
  const mutatedBaseline = JSON.parse(JSON.stringify(baseline));
  mutatedBaseline.samples["K1-relevant-timeout-knowledge"].knowledgeUsage = "partial";

  const evaluation = evaluateDatasetV5(dataset); // current (real) K1 sample stays knowledgeUsage=pass
  const comparison = compareEvaluationToBaselineV5(evaluation, mutatedBaseline);
  const k1Result = comparison.samples.find((s) => s.id === "K1-relevant-timeout-knowledge");
  assert.equal(k1Result.knowledgeUsage.change, "improvement");
  assert.equal(comparison.status, "IMPROVED");
  // baseline-v5.json on disk was never touched.
});
