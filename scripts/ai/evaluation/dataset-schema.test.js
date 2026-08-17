"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateDataset } = require("./dataset-schema");

const DATASET_PATH = path.join(__dirname, "dataset.json");

function loadRealDataset() {
  return JSON.parse(fs.readFileSync(DATASET_PATH, "utf8"));
}

// Minimal valid sample used as a base for the negative-path tests below, so
// each test only has to mutate the one field it's actually checking.
function makeValidSample(overrides) {
  const base = {
    id: "sample-1",
    scenario: "some-scenario",
    groundTruth: {
      classification: "TEST_BUG",
      shouldRetry: false,
      shouldCreateBug: false,
    },
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
    },
    ambiguity: {
      isAmbiguous: false,
      reason: null,
    },
    metadata: {
      experiment: 1,
      provider: "groq",
      model: "openai/gpt-oss-120b",
      PR: 1,
      workflowRun: 1,
    },
  };
  return { ...base, ...overrides };
}

function makeValidDataset(samples) {
  return { version: 1, samples: samples || [makeValidSample()] };
}

test("the real dataset.json validates successfully", () => {
  const dataset = loadRealDataset();
  const result = validateDataset(dataset);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the real dataset.json contains exactly the 4 expected experiment samples", () => {
  const dataset = loadRealDataset();
  const ids = dataset.samples.map((sample) => sample.id).sort();
  assert.deepEqual(ids, [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-5-real-flaky-test",
  ]);
});

test("a well-formed dataset passes validation", () => {
  const result = validateDataset(makeValidDataset());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("duplicate sample ids fail validation", () => {
  const dataset = makeValidDataset([
    makeValidSample({ id: "dup" }),
    makeValidSample({ id: "dup" }),
  ]);
  const result = validateDataset(dataset);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("duplicate sample id")));
});

test("an invalid classification fails validation", () => {
  const sample = makeValidSample({
    groundTruth: { classification: "NOT_A_REAL_CLASSIFICATION", shouldRetry: false, shouldCreateBug: false },
  });
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("groundTruth.classification")));
});

test("confidence below 0 fails validation", () => {
  const sample = makeValidSample();
  sample.actual = { ...sample.actual, confidence: -0.1 };
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("actual.confidence")));
});

test("confidence above 1 fails validation", () => {
  const sample = makeValidSample();
  sample.actual = { ...sample.actual, confidence: 1.1 };
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("actual.confidence")));
});

test("a missing groundTruth fails validation", () => {
  const sample = makeValidSample();
  delete sample.groundTruth;
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("groundTruth: must be an object")));
});

test("an invalid quality enum value fails validation", () => {
  const sample = makeValidSample();
  sample.quality = { ...sample.quality, rootCause: "sort_of" };
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("quality.rootCause")));
});

test("an ambiguous sample without a reason fails validation", () => {
  const sample = makeValidSample({
    quality: {
      classification: "ambiguous",
      rootCause: "partial",
      evidence: "partial",
      recommendedFix: "pass",
      historyUsage: "neutral",
      fabricatedEvidence: false,
    },
  });
  sample.ambiguity = { isAmbiguous: true, reason: null };
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("ambiguity.reason")));
});

test("isAmbiguous=true with quality.classification != ambiguous fails validation", () => {
  const sample = makeValidSample();
  sample.quality = { ...sample.quality, classification: "fail" };
  sample.ambiguity = { isAmbiguous: true, reason: "some reason" };
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("ambiguity.isAmbiguous is true")));
});

test("isAmbiguous=false with quality.classification == ambiguous fails validation", () => {
  const sample = makeValidSample();
  sample.quality = { ...sample.quality, classification: "ambiguous" };
  sample.ambiguity = { isAmbiguous: false, reason: null };
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('quality.classification is "ambiguous"')));
});

test("an invalid boolean field fails validation", () => {
  const sample = makeValidSample();
  sample.actual = { ...sample.actual, shouldRetry: "yes" };
  const result = validateDataset(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("actual.shouldRetry")));
});
