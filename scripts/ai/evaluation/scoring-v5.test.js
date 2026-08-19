"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { evaluateDatasetV5, scoreSampleV5, scoreKnowledgeSelection, scoreModelShouldCreateBugCorrect } = require("./scoring-v5");

test("scoreKnowledgeSelection: not_applicable when knowledge.applicable is false", () => {
  assert.equal(scoreKnowledgeSelection({ applicable: false }), "not_applicable");
  assert.equal(scoreKnowledgeSelection(null), "not_applicable");
});

test("scoreKnowledgeSelection: K5's exact [] shape passes", () => {
  const knowledge = { applicable: true, expectedPresentUnitIds: [], expectedAbsentUnitIds: ["unit-a"], expectedExactSelectedUnitIds: [], actualSelectedUnitIds: [] };
  assert.equal(scoreKnowledgeSelection(knowledge), "pass");
});

test("scoreKnowledgeSelection: expected present unit missing from actual -> fail", () => {
  const knowledge = { applicable: true, expectedPresentUnitIds: ["unit-a"], expectedAbsentUnitIds: [], expectedExactSelectedUnitIds: null, actualSelectedUnitIds: ["unit-b"] };
  assert.equal(scoreKnowledgeSelection(knowledge), "fail");
});

test("scoreKnowledgeSelection: expected absent unit appears in actual -> fail", () => {
  const knowledge = { applicable: true, expectedPresentUnitIds: [], expectedAbsentUnitIds: ["unit-a"], expectedExactSelectedUnitIds: null, actualSelectedUnitIds: ["unit-a"] };
  assert.equal(scoreKnowledgeSelection(knowledge), "fail");
});

test("scoreKnowledgeSelection: exact set mismatch (extra unit present) -> fail even though presence/absence alone would pass", () => {
  const knowledge = {
    applicable: true,
    expectedPresentUnitIds: ["unit-a"],
    expectedAbsentUnitIds: [],
    expectedExactSelectedUnitIds: ["unit-a"],
    actualSelectedUnitIds: ["unit-a", "unit-unexpected"],
  };
  assert.equal(scoreKnowledgeSelection(knowledge), "fail");
});

test("scoreKnowledgeSelection: exact set omitted -> only presence/absence subset semantics apply (extra legitimate unit does not fail it)", () => {
  const knowledge = {
    applicable: true,
    expectedPresentUnitIds: ["unit-a"],
    expectedAbsentUnitIds: ["unit-b"],
    expectedExactSelectedUnitIds: null,
    actualSelectedUnitIds: ["unit-a", "unit-legitimately-extra"],
  };
  assert.equal(scoreKnowledgeSelection(knowledge), "pass");
});

test("scoreModelShouldCreateBugCorrect: K3's shape - raw model wrong (originalShouldCreateBug=true for a groundTruth-false sample)", () => {
  const actual = { originalShouldCreateBug: true };
  const groundTruth = { shouldCreateBug: false };
  assert.equal(scoreModelShouldCreateBugCorrect(actual, groundTruth), false);
});

test("scoreModelShouldCreateBugCorrect: K1/K4/K5's shape - raw model correct", () => {
  const actual = { originalShouldCreateBug: false };
  const groundTruth = { shouldCreateBug: false };
  assert.equal(scoreModelShouldCreateBugCorrect(actual, groundTruth), true);
});

test("scoreModelShouldCreateBugCorrect: returns null (not evaluated) when originalShouldCreateBug is missing", () => {
  assert.equal(scoreModelShouldCreateBugCorrect({}, { shouldCreateBug: false }), null);
});

test("scoreSampleV5: shouldCreateBug (final) is still scored against finalShouldCreateBug, never originalShouldCreateBug - K3's model-wrong/final-right divergence", () => {
  const sample = {
    id: "k3-like",
    ambiguity: { isAmbiguous: false },
    groundTruth: { classification: "TEST_BUG", shouldRetry: false, shouldCreateBug: false },
    actual: { classification: "TEST_BUG", shouldRetry: false, originalShouldCreateBug: true, finalShouldCreateBug: false, policyAdjusted: true },
    quality: { fabricatedEvidence: false, rootCause: "pass", evidence: "pass", recommendedFix: "pass" },
    correlation: { applicable: false },
    knowledge: { applicable: false },
  };
  const scored = scoreSampleV5(sample);
  assert.equal(scored.shouldCreateBug.correct, true, "final shouldCreateBug must be correct (matches groundTruth via policy)");
  assert.equal(scored.modelShouldCreateBugCorrect, false, "raw model shouldCreateBug must be flagged wrong");
});

test("evaluateDatasetV5 on the real dataset-v5.json produces expected aggregate shape", () => {
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v5.json"), "utf8"));
  const { metrics, samples } = evaluateDatasetV5(dataset);

  assert.equal(metrics.totalSamples, 13);
  assert.equal(samples.length, 13);
  // K3 and experiment-47 are the two known modelShouldCreateBugCorrect=false samples.
  assert.equal(metrics.modelShouldCreateBugIncorrect, 2);
  const wrongIds = samples.filter((s) => s.modelShouldCreateBugCorrect === false).map((s) => s.id).sort();
  assert.deepEqual(wrongIds, ["K3-cross-browser-differing-signatures", "experiment-47-post-prompt-grounding-revalidation"].sort());
});

test("evaluateDatasetV5 never reads dataset.historicalObservations into any metric (K2 must not silently become a scorable sample)", () => {
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v5.json"), "utf8"));
  const withHistorical = evaluateDatasetV5(dataset);
  const withoutHistorical = evaluateDatasetV5({ ...dataset, historicalObservations: undefined });
  assert.deepEqual(withHistorical.metrics, withoutHistorical.metrics);
});

test("K5's sample scores knowledgeSelectionCorrect=pass and both knowledgeUsage/knowledgeGrounding as not_applicable", () => {
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v5.json"), "utf8"));
  const { samples } = evaluateDatasetV5(dataset);
  const k5 = samples.find((s) => s.id === "K5-zero-relevant-knowledge");
  assert.equal(k5.knowledgeSelectionCorrect, "pass");
  assert.equal(k5.quality.knowledgeUsage, "not_applicable");
  assert.equal(k5.quality.knowledgeGrounding, "not_applicable");
});
