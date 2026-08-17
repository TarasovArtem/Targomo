"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateDatasetV3, validateSampleV3 } = require("./dataset-v3-schema");

const DATASET_V3_PATH = path.join(__dirname, "dataset-v3.json");
const DATASET_V2_PATH = path.join(__dirname, "dataset-v2.json");

function loadRealDatasetV3() {
  return JSON.parse(fs.readFileSync(DATASET_V3_PATH, "utf8"));
}

function loadRealDatasetV2() {
  return JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf8"));
}

function makeValidSample(overrides = {}) {
  const base = {
    id: "sample-1",
    scenario: "some-scenario",
    groundTruth: { classification: "TEST_BUG", shouldRetry: false, shouldCreateBug: false },
    actual: {
      classification: "TEST_BUG",
      confidence: 0.5,
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
    },
    ambiguity: { isAmbiguous: false, reason: null },
    correlation: { applicable: false, observed: null },
    metadata: { experiment: 1, provider: "groq", model: "m", PR: 1, workflowRun: 1 },
  };
  return { ...base, ...overrides };
}

test("real dataset-v3.json validates successfully", () => {
  const dataset = loadRealDatasetV3();
  const result = validateDatasetV3(dataset);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("real dataset-v3.json contains exactly the 7 expected sample IDs", () => {
  const dataset = loadRealDatasetV3();
  const ids = dataset.samples.map((s) => s.id);
  assert.deepEqual(ids, [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-5-real-flaky-test",
    "experiment-A-multi-browser-same-signature",
    "experiment-B-multi-browser-different-signatures",
    "experiment-41-correlation-necessary-grounding",
  ]);
});

test("Experiment #41 sample individually validates", () => {
  const dataset = loadRealDatasetV3();
  const exp41 = dataset.samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");
  assert.ok(exp41, "expected to find the Experiment #41 sample");
  const result = validateSampleV3(exp41);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("migration integrity: every Dataset v2 sample's fields are deeply equal in Dataset v3", () => {
  const v2 = loadRealDatasetV2();
  const v3 = loadRealDatasetV3();

  for (const v2Sample of v2.samples) {
    const v3Sample = v3.samples.find((s) => s.id === v2Sample.id);
    assert.ok(v3Sample, `expected Dataset v3 to contain migrated sample "${v2Sample.id}"`);
    assert.deepEqual(v3Sample, v2Sample, `Dataset v3's "${v2Sample.id}" must be byte-for-byte identical to Dataset v2's`);
  }
});

test("a valid synthetic dataset passes validation", () => {
  const result = validateDatasetV3({ version: 3, samples: [makeValidSample()] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("an unsupported version fails validation", () => {
  const result = validateDatasetV3({ version: 2, samples: [makeValidSample()] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("dataset.version")));
});

test("a duplicate sample ID fails validation", () => {
  const result = validateDatasetV3({
    version: 3,
    samples: [makeValidSample({ id: "dup" }), makeValidSample({ id: "dup" })],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate sample id "dup"')));
});

test("an invalid classification fails validation", () => {
  const result = validateDatasetV3({
    version: 3,
    samples: [makeValidSample({ groundTruth: { classification: "NOT_REAL", shouldRetry: false, shouldCreateBug: false } })],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("groundTruth.classification")));
});

test("an invalid fabricatedEvidence fails validation", () => {
  const base = makeValidSample();
  const result = validateDatasetV3({
    version: 3,
    samples: [{ ...base, quality: { ...base.quality, fabricatedEvidence: "true" } }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("fabricatedEvidence")));
});

test("an invalid correlation (applicable=true but observed=null) fails validation", () => {
  const result = validateDatasetV3({
    version: 3,
    samples: [makeValidSample({ correlation: { applicable: true, observed: null } })],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlation.observed")));
});

test("an invalid ambiguity (isAmbiguous=true but no reason) fails validation", () => {
  const result = validateDatasetV3({
    version: 3,
    samples: [makeValidSample({ ambiguity: { isAmbiguous: true, reason: null } })],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("ambiguity.reason")));
});

test("a non-object dataset fails validation", () => {
  const result = validateDatasetV3(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("dataset: must be an object")));
});
