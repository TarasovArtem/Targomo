"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateDatasetV5, validateSampleV5 } = require("./dataset-v5-schema");

function makeSample(overrides = {}) {
  return {
    id: "fixture-sample",
    scenario: "fixture-scenario",
    description: "A fixture sample.",
    groundTruth: { classification: "TEST_BUG", shouldRetry: false, shouldCreateBug: false },
    actual: {
      classification: "TEST_BUG",
      confidence: 0.9,
      shouldRetry: false,
      originalShouldCreateBug: false,
      finalShouldCreateBug: false,
      policyAdjusted: false,
    },
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
      knowledgeUsage: "not_applicable",
      knowledgeGrounding: "not_applicable",
      inferenceQuality: null,
    },
    ambiguity: { isAmbiguous: false, reason: null },
    correlation: { applicable: false, observed: null },
    knowledge: { applicable: false, expectedPresentUnitIds: null, expectedAbsentUnitIds: null, expectedExactSelectedUnitIds: null, actualSelectedUnitIds: null },
    metadata: { experiment: "fixture", provider: "groq", model: "openai/gpt-oss-120b", PR: 1, workflowRun: 111 },
    ...overrides,
  };
}

test("a minimal valid sample passes validation", () => {
  const result = validateSampleV5(makeSample());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("knowledge.applicable=true requires expectedPresent/expectedAbsent/actualSelectedUnitIds arrays", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: null, expectedAbsentUnitIds: [], expectedExactSelectedUnitIds: null, actualSelectedUnitIds: [] },
    quality: { ...makeSample().quality, knowledgeUsage: "not_applicable", knowledgeGrounding: "not_applicable" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("expectedPresentUnitIds")));
});

test("knowledge.applicable=false requires all knowledge fields to be null", () => {
  const sample = makeSample({
    knowledge: { applicable: false, expectedPresentUnitIds: [], expectedAbsentUnitIds: null, expectedExactSelectedUnitIds: null, actualSelectedUnitIds: null },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("expectedPresentUnitIds: must be null")));
});

test("expectedPresentUnitIds and expectedAbsentUnitIds must not share a unit id", () => {
  const sample = makeSample({
    knowledge: {
      applicable: true,
      expectedPresentUnitIds: ["unit-a"],
      expectedAbsentUnitIds: ["unit-a"],
      expectedExactSelectedUnitIds: null,
      actualSelectedUnitIds: ["unit-a"],
    },
    quality: { ...makeSample().quality, knowledgeUsage: "pass", knowledgeGrounding: "pass" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("cannot appear in both")));
});

test("expectedExactSelectedUnitIds is optional even when knowledge.applicable is true (presence/absence-only shape)", () => {
  const sample = makeSample({
    knowledge: {
      applicable: true,
      expectedPresentUnitIds: ["unit-a"],
      expectedAbsentUnitIds: ["unit-b"],
      expectedExactSelectedUnitIds: null,
      actualSelectedUnitIds: ["unit-a"],
    },
    quality: { ...makeSample().quality, knowledgeUsage: "pass", knowledgeGrounding: "pass" },
  });
  const result = validateSampleV5(sample);
  assert.deepEqual(result.errors, []);
});

test("knowledgeUsage/knowledgeGrounding must be not_applicable when no knowledge was actually selected (K5's shape: applicable=true, actualSelectedUnitIds=[])", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: [], expectedAbsentUnitIds: ["unit-a"], expectedExactSelectedUnitIds: [], actualSelectedUnitIds: [] },
    quality: { ...makeSample().quality, knowledgeUsage: "not_applicable", knowledgeGrounding: "not_applicable" },
  });
  const result = validateSampleV5(sample);
  assert.deepEqual(result.errors, []);
});

test("knowledgeUsage cannot be not_applicable when knowledge was actually selected", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: ["unit-a"], expectedAbsentUnitIds: [], expectedExactSelectedUnitIds: null, actualSelectedUnitIds: ["unit-a"] },
    quality: { ...makeSample().quality, knowledgeUsage: "not_applicable", knowledgeGrounding: "pass" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("knowledge was actually selected")));
});

test("inferenceQuality accepts null (not yet curated), distinct from not_applicable", () => {
  const sample = makeSample({ quality: { ...makeSample().quality, inferenceQuality: null } });
  assert.deepEqual(validateSampleV5(sample).errors, []);
});

test("inferenceQuality rejects invalid string values", () => {
  const sample = makeSample({ quality: { ...makeSample().quality, inferenceQuality: "sort-of" } });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("inferenceQuality")));
});

test("expectedExactSelectedUnitIds, when present, must be consistent with expectedPresent/expectedAbsent", () => {
  const sample = makeSample({
    knowledge: {
      applicable: true,
      expectedPresentUnitIds: ["unit-a"],
      expectedAbsentUnitIds: ["unit-b"],
      expectedExactSelectedUnitIds: ["unit-c"], // missing unit-a
      actualSelectedUnitIds: ["unit-c"],
    },
    quality: { ...makeSample().quality, knowledgeUsage: "pass", knowledgeGrounding: "pass" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("missing")));
});

// --- Roadmap #16E.2.1: duplicate knowledge-unit-id hardening -------------
//
// The #16E.2 independent review found that expectedPresentUnitIds/
// expectedAbsentUnitIds/expectedExactSelectedUnitIds/actualSelectedUnitIds
// used isStringArray (any strings) rather than a uniqueness-checking
// validator, so a duplicate id like ["unit-a", "unit-a"] validated
// cleanly. scoreKnowledgeSelection() itself was never corrupted by this
// (it is Set-based), but curated dataset input should fail loudly on a
// duplicate/blank id rather than silently accept it - these tests prove
// each of the four arrays independently rejects duplicates, and that []
// (K5's exact zero-selection shape) remains valid throughout.

test("duplicate ids in expectedPresentUnitIds are rejected", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: ["unit-a", "unit-a"], expectedAbsentUnitIds: [], expectedExactSelectedUnitIds: null, actualSelectedUnitIds: ["unit-a"] },
    quality: { ...makeSample().quality, knowledgeUsage: "pass", knowledgeGrounding: "pass" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("expectedPresentUnitIds") && e.includes("unique")));
});

test("duplicate ids in expectedAbsentUnitIds are rejected", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: [], expectedAbsentUnitIds: ["unit-b", "unit-b"], expectedExactSelectedUnitIds: null, actualSelectedUnitIds: [] },
    quality: { ...makeSample().quality, knowledgeUsage: "not_applicable", knowledgeGrounding: "not_applicable" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("expectedAbsentUnitIds") && e.includes("unique")));
});

test("duplicate ids in expectedExactSelectedUnitIds are rejected", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: ["unit-a"], expectedAbsentUnitIds: [], expectedExactSelectedUnitIds: ["unit-a", "unit-a"], actualSelectedUnitIds: ["unit-a"] },
    quality: { ...makeSample().quality, knowledgeUsage: "pass", knowledgeGrounding: "pass" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("expectedExactSelectedUnitIds") && e.includes("unique")));
});

test("duplicate ids in actualSelectedUnitIds are rejected", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: ["unit-a"], expectedAbsentUnitIds: [], expectedExactSelectedUnitIds: null, actualSelectedUnitIds: ["unit-a", "unit-a"] },
    quality: { ...makeSample().quality, knowledgeUsage: "pass", knowledgeGrounding: "pass" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("actualSelectedUnitIds") && e.includes("unique")));
});

test("empty knowledge-unit-id arrays remain valid in all four fields (K5's exact zero-selection shape must not be rejected by the uniqueness check)", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: [], expectedAbsentUnitIds: ["unit-a"], expectedExactSelectedUnitIds: [], actualSelectedUnitIds: [] },
    quality: { ...makeSample().quality, knowledgeUsage: "not_applicable", knowledgeGrounding: "not_applicable" },
  });
  const result = validateSampleV5(sample);
  assert.deepEqual(result.errors, []);
});

test("a blank/whitespace-only string id is rejected the same way a duplicate is", () => {
  const sample = makeSample({
    knowledge: { applicable: true, expectedPresentUnitIds: ["  "], expectedAbsentUnitIds: [], expectedExactSelectedUnitIds: null, actualSelectedUnitIds: ["  "] },
    quality: { ...makeSample().quality, knowledgeUsage: "pass", knowledgeGrounding: "pass" },
  });
  const result = validateSampleV5(sample);
  assert.equal(result.valid, false);
});

test("historicalObservations are validated with a lighter shape and are structurally separate from samples", () => {
  const dataset = {
    version: 5,
    samples: [makeSample()],
    historicalObservations: [
      {
        id: "K2-example",
        summary: "some historical summary",
        reason: "not scorable",
        metadata: { experiment: "K2" },
      },
    ],
  };
  const result = validateDatasetV5(dataset);
  assert.deepEqual(result.errors, []);
});

test("historicalObservations id colliding with a scorable sample id is rejected", () => {
  const dataset = {
    version: 5,
    samples: [makeSample({ id: "shared-id" })],
    historicalObservations: [{ id: "shared-id", summary: "x", reason: "y", metadata: {} }],
  };
  const result = validateDatasetV5(dataset);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("collides")));
});

test("the real dataset-v5.json file validates cleanly", () => {
  const raw = fs.readFileSync(path.join(__dirname, "dataset-v5.json"), "utf8");
  const dataset = JSON.parse(raw);
  const result = validateDatasetV5(dataset);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the real dataset-v5.json inherits every v4 sample id, and their pre-v5 fields remain byte-identical", () => {
  const v4 = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v4.json"), "utf8"));
  const v5 = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v5.json"), "utf8"));
  const v5ById = Object.fromEntries(v5.samples.map((s) => [s.id, s]));

  for (const v4Sample of v4.samples) {
    const v5Sample = v5ById[v4Sample.id];
    assert.ok(v5Sample, `v4 sample "${v4Sample.id}" must be inherited into v5`);
    assert.deepEqual(v5Sample.groundTruth, v4Sample.groundTruth, `${v4Sample.id}.groundTruth must be byte-identical`);
    assert.deepEqual(v5Sample.actual, v4Sample.actual, `${v4Sample.id}.actual must be byte-identical`);
    assert.deepEqual(v5Sample.ambiguity, v4Sample.ambiguity, `${v4Sample.id}.ambiguity must be byte-identical`);
    assert.deepEqual(v5Sample.correlation, v4Sample.correlation, `${v4Sample.id}.correlation must be byte-identical`);
    assert.deepEqual(v5Sample.metadata, v4Sample.metadata, `${v4Sample.id}.metadata must be byte-identical`);
    for (const field of ["classification", "rootCause", "evidence", "recommendedFix", "historyUsage", "fabricatedEvidence", "correlationConstruction", "correlationTransport", "correlationReasoning"]) {
      assert.equal(v5Sample.quality[field], v4Sample.quality[field], `${v4Sample.id}.quality.${field} must be byte-identical`);
    }
  }
});

test("inherited pre-knowledge v5 samples do NOT pretend relevantKnowledge=[] - knowledge.applicable is false, not true with an empty array", () => {
  const v4 = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v4.json"), "utf8"));
  const v5 = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v5.json"), "utf8"));
  const v5ById = Object.fromEntries(v5.samples.map((s) => [s.id, s]));

  for (const v4Sample of v4.samples) {
    const v5Sample = v5ById[v4Sample.id];
    assert.equal(v5Sample.knowledge.applicable, false, `${v4Sample.id}: pre-knowledge sample must have knowledge.applicable=false, not a true+[] shape`);
    assert.equal(v5Sample.knowledge.actualSelectedUnitIds, null, `${v4Sample.id}: pre-knowledge sample must not carry actualSelectedUnitIds=[] (that would falsely imply the selector ran)`);
  }
});

test("K5's sample genuinely represents applicable=true with an exact empty selected set - the opposite shape of a pre-knowledge sample", () => {
  const v5 = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v5.json"), "utf8"));
  const k5 = v5.samples.find((s) => s.id === "K5-zero-relevant-knowledge");
  assert.ok(k5, "K5 sample must exist");
  assert.equal(k5.knowledge.applicable, true);
  assert.deepEqual(k5.knowledge.actualSelectedUnitIds, []);
  assert.deepEqual(k5.knowledge.expectedExactSelectedUnitIds, []);
});

test("K2 does not appear in dataset.samples (must never be scored as an ordinary passing sample)", () => {
  const v5 = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset-v5.json"), "utf8"));
  assert.equal(v5.samples.some((s) => s.id.startsWith("K2")), false);
  assert.ok(v5.historicalObservations.some((o) => o.id.startsWith("K2")));
});
