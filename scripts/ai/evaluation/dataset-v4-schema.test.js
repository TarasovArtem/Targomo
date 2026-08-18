"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateDatasetV4, validateSampleV4 } = require("./dataset-v4-schema");

const DATASET_V4_PATH = path.join(__dirname, "dataset-v4.json");
const DATASET_V3_PATH = path.join(__dirname, "dataset-v3.json");

function loadRealDatasetV4() {
  return JSON.parse(fs.readFileSync(DATASET_V4_PATH, "utf8"));
}

function loadRealDatasetV3() {
  return JSON.parse(fs.readFileSync(DATASET_V3_PATH, "utf8"));
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

test("real dataset-v4.json validates successfully", () => {
  const dataset = loadRealDatasetV4();
  const result = validateDatasetV4(dataset);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("real dataset-v4.json contains exactly the 9 expected sample IDs", () => {
  const dataset = loadRealDatasetV4();
  const ids = dataset.samples.map((s) => s.id);
  assert.deepEqual(ids, [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-5-real-flaky-test",
    "experiment-A-multi-browser-same-signature",
    "experiment-B-multi-browser-different-signatures",
    "experiment-41-correlation-necessary-grounding",
    "experiment-45-post-prompt-grounding-revalidation",
    "experiment-47-post-prompt-grounding-revalidation",
  ]);
});

test("both post-prompt samples individually validate", () => {
  const dataset = loadRealDatasetV4();
  for (const id of ["experiment-45-post-prompt-grounding-revalidation", "experiment-47-post-prompt-grounding-revalidation"]) {
    const sample = dataset.samples.find((s) => s.id === id);
    assert.ok(sample, `expected to find sample "${id}"`);
    const result = validateSampleV4(sample);
    assert.deepEqual(result.errors, [], `${id} should validate cleanly`);
    assert.equal(result.valid, true);
  }
});

// A. Migration integrity: all 7 Dataset v3 samples are deeply identical in v4.
test("migration integrity: every Dataset v3 sample's fields are deeply equal in Dataset v4", () => {
  const v3 = loadRealDatasetV3();
  const v4 = loadRealDatasetV4();

  assert.equal(v3.samples.length, 7, "sanity check: Dataset v3 should have 7 samples");

  for (const v3Sample of v3.samples) {
    const v4Sample = v4.samples.find((s) => s.id === v3Sample.id);
    assert.ok(v4Sample, `expected Dataset v4 to contain migrated sample "${v3Sample.id}"`);
    assert.deepEqual(v4Sample, v3Sample, `Dataset v4's "${v3Sample.id}" must be byte-for-byte identical to Dataset v3's`);
  }
});

// B. Post-prompt samples remain distinct: exactly two new samples exist, and
// they are not the same object / do not collapse into one averaged sample.
test("exactly two new post-prompt samples exist in Dataset v4, and they are distinct from each other", () => {
  const v3 = loadRealDatasetV3();
  const v4 = loadRealDatasetV4();

  const v3Ids = new Set(v3.samples.map((s) => s.id));
  const newSamples = v4.samples.filter((s) => !v3Ids.has(s.id));

  assert.equal(newSamples.length, 2, "expected exactly 2 samples beyond the 7 inherited from Dataset v3");
  assert.equal(v4.samples.length, 9);

  const [first, second] = newSamples;
  assert.notEqual(first.id, second.id);
  assert.notDeepEqual(first, second, "the two post-prompt samples must not be identical/averaged");
  assert.ok(!/combined/i.test(first.id));
  assert.ok(!/combined/i.test(second.id));
  assert.equal(first.metadata.PR, 45);
  assert.equal(second.metadata.PR, 47);
});

// C. fabricatedEvidence: false for both post-prompt samples.
test("both post-prompt samples have fabricatedEvidence=false", () => {
  const dataset = loadRealDatasetV4();
  for (const id of ["experiment-45-post-prompt-grounding-revalidation", "experiment-47-post-prompt-grounding-revalidation"]) {
    const sample = dataset.samples.find((s) => s.id === id);
    assert.equal(sample.quality.fabricatedEvidence, false, `${id} should have fabricatedEvidence=false`);
  }
});

// D. Qualitative baseline: both samples rootCause=pass, evidence=pass,
// recommendedFix=pass.
test("both post-prompt samples have rootCause/evidence/recommendedFix all pass", () => {
  const dataset = loadRealDatasetV4();
  for (const id of ["experiment-45-post-prompt-grounding-revalidation", "experiment-47-post-prompt-grounding-revalidation"]) {
    const sample = dataset.samples.find((s) => s.id === id);
    assert.equal(sample.quality.rootCause, "pass", `${id} rootCause`);
    assert.equal(sample.quality.evidence, "pass", `${id} evidence`);
    assert.equal(sample.quality.recommendedFix, "pass", `${id} recommendedFix`);
  }
});

// E. correlationReasoning: pass for both.
test("both post-prompt samples have correlationReasoning=pass", () => {
  const dataset = loadRealDatasetV4();
  for (const id of ["experiment-45-post-prompt-grounding-revalidation", "experiment-47-post-prompt-grounding-revalidation"]) {
    const sample = dataset.samples.find((s) => s.id === id);
    assert.equal(sample.quality.correlationReasoning, "pass", `${id} correlationReasoning`);
  }
});

// F. Experiment #41 preserved exactly as the pre-prompt historical deficiency.
test("Experiment #41 remains the unmodified pre-prompt historical deficiency in Dataset v4", () => {
  const dataset = loadRealDatasetV4();
  const exp41 = dataset.samples.find((s) => s.id === "experiment-41-correlation-necessary-grounding");
  assert.ok(exp41);
  assert.equal(exp41.groundTruth.classification, "TEST_BUG");
  assert.equal(exp41.groundTruth.shouldRetry, false);
  assert.equal(exp41.groundTruth.shouldCreateBug, false);
  assert.equal(exp41.quality.fabricatedEvidence, true);
  assert.equal(exp41.quality.rootCause, "fail");
  assert.equal(exp41.quality.evidence, "fail");
  assert.equal(exp41.quality.recommendedFix, "partial");
  assert.equal(exp41.quality.correlationReasoning, "fail");
});

// Ground truth preserved: the controlled scenario's ground truth is
// unchanged across all three samples (historical + both revalidations).
test("ground truth is identical (TEST_BUG/false/false) across Experiment #41 and both post-prompt samples", () => {
  const dataset = loadRealDatasetV4();
  for (const id of [
    "experiment-41-correlation-necessary-grounding",
    "experiment-45-post-prompt-grounding-revalidation",
    "experiment-47-post-prompt-grounding-revalidation",
  ]) {
    const sample = dataset.samples.find((s) => s.id === id);
    assert.deepEqual(sample.groundTruth, { classification: "TEST_BUG", shouldRetry: false, shouldCreateBug: false }, id);
  }
});

// Provenance: providerAttempts/firstAttemptError preserved distinctly per
// the actual verified retry behavior of each observation.
test("provenance: PR #45 sample records 2 provider attempts and the original malformed-JSON error", () => {
  const dataset = loadRealDatasetV4();
  const sample = dataset.samples.find((s) => s.id === "experiment-45-post-prompt-grounding-revalidation");
  assert.equal(sample.metadata.providerAttempts, 2);
  assert.match(sample.metadata.firstAttemptError, /not valid JSON/i);
  assert.equal(sample.metadata.PR, 45);
  assert.equal(sample.metadata.workflowRun, 32119087170);
});

test("provenance: PR #47 sample records 1 provider attempt and no first-attempt error", () => {
  const dataset = loadRealDatasetV4();
  const sample = dataset.samples.find((s) => s.id === "experiment-47-post-prompt-grounding-revalidation");
  assert.equal(sample.metadata.providerAttempts, 1);
  assert.equal(sample.metadata.firstAttemptError, null);
  assert.equal(sample.metadata.PR, 47);
  assert.equal(sample.metadata.workflowRun, 32125240102);
});

// Policy provenance: the application-safeguard intervention in observation
// #2 (raw model recommended shouldCreateBug=true, policy forced false) is
// preserved distinctly from observation #1 (no intervention needed).
test("policy provenance: PR #45 needed no safeguard intervention, PR #47 did", () => {
  const dataset = loadRealDatasetV4();
  const obs1 = dataset.samples.find((s) => s.id === "experiment-45-post-prompt-grounding-revalidation");
  const obs2 = dataset.samples.find((s) => s.id === "experiment-47-post-prompt-grounding-revalidation");

  assert.equal(obs1.actual.originalShouldCreateBug, false);
  assert.equal(obs1.actual.finalShouldCreateBug, false);
  assert.equal(obs1.actual.policyAdjusted, false);

  assert.equal(obs2.actual.originalShouldCreateBug, true);
  assert.equal(obs2.actual.finalShouldCreateBug, false);
  assert.equal(obs2.actual.policyAdjusted, true);
});

test("a valid synthetic dataset passes validation", () => {
  const result = validateDatasetV4({ version: 4, samples: [makeValidSample()] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("an unsupported version fails validation", () => {
  const result = validateDatasetV4({ version: 3, samples: [makeValidSample()] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("dataset.version")));
});

test("a duplicate sample ID fails validation", () => {
  const result = validateDatasetV4({
    version: 4,
    samples: [makeValidSample({ id: "dup" }), makeValidSample({ id: "dup" })],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate sample id "dup"')));
});

test("an invalid classification fails validation", () => {
  const result = validateDatasetV4({
    version: 4,
    samples: [makeValidSample({ groundTruth: { classification: "NOT_REAL", shouldRetry: false, shouldCreateBug: false } })],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("groundTruth.classification")));
});

test("an invalid fabricatedEvidence fails validation", () => {
  const base = makeValidSample();
  const result = validateDatasetV4({
    version: 4,
    samples: [{ ...base, quality: { ...base.quality, fabricatedEvidence: "true" } }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("fabricatedEvidence")));
});

test("an invalid correlation (applicable=true but observed=null) fails validation", () => {
  const result = validateDatasetV4({
    version: 4,
    samples: [makeValidSample({ correlation: { applicable: true, observed: null } })],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlation.observed")));
});

test("an invalid ambiguity (isAmbiguous=true but no reason) fails validation", () => {
  const result = validateDatasetV4({
    version: 4,
    samples: [makeValidSample({ ambiguity: { isAmbiguous: true, reason: null } })],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("ambiguity.reason")));
});

test("a non-object dataset fails validation", () => {
  const result = validateDatasetV4(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("dataset: must be an object")));
});

// v4-only provenance field validation.
test("a non-integer providerAttempts fails validation", () => {
  const base = makeValidSample();
  const result = validateDatasetV4({
    version: 4,
    samples: [{ ...base, metadata: { ...base.metadata, providerAttempts: 1.5 } }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("providerAttempts")));
});

test("providerAttempts is optional and omitting it does not fail validation", () => {
  const result = validateDatasetV4({ version: 4, samples: [makeValidSample()] });
  assert.equal(result.valid, true);
});

test("firstAttemptError as a non-null string with providerAttempts=1 fails validation", () => {
  const base = makeValidSample();
  const result = validateDatasetV4({
    version: 4,
    samples: [{ ...base, metadata: { ...base.metadata, providerAttempts: 1, firstAttemptError: "some error" } }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("firstAttemptError")));
});

test("firstAttemptError as a non-empty string with providerAttempts=2 passes validation", () => {
  const base = makeValidSample();
  const result = validateDatasetV4({
    version: 4,
    samples: [{ ...base, metadata: { ...base.metadata, providerAttempts: 2, firstAttemptError: "malformed JSON" } }],
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("an empty-string firstAttemptError fails validation (must be non-empty or null)", () => {
  const base = makeValidSample();
  const result = validateDatasetV4({
    version: 4,
    samples: [{ ...base, metadata: { ...base.metadata, providerAttempts: 2, firstAttemptError: "" } }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("firstAttemptError")));
});
