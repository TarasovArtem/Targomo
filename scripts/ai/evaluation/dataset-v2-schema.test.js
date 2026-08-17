"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateDatasetV2 } = require("./dataset-v2-schema");

const DATASET_V1_PATH = path.join(__dirname, "dataset.json");
const DATASET_V2_PATH = path.join(__dirname, "dataset-v2.json");

function loadRealDatasetV1() {
  return JSON.parse(fs.readFileSync(DATASET_V1_PATH, "utf8"));
}

function loadRealDatasetV2() {
  return JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf8"));
}

function makeNotApplicableCorrelation() {
  return { applicable: false, observed: null };
}

function makeApplicableCorrelation(overrides = {}) {
  return {
    applicable: true,
    observed: {
      browsers: ["chrome", "edge"],
      failedBrowsers: ["chrome", "edge"],
      passedBrowsers: [],
      primaryBrowser: "chrome",
      additionalFailedBrowsers: ["edge"],
      failureScope: "multi-browser",
      sameFailureSignature: true,
      ...overrides,
    },
  };
}

// Minimal valid v2 sample - not_applicable correlation by default, so
// individual tests only override what they're actually exercising.
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
    correlation: makeNotApplicableCorrelation(),
    metadata: { experiment: 1, provider: "groq", model: "openai/gpt-oss-120b", PR: 1, workflowRun: 1 },
  };
  return { ...base, ...overrides };
}

function makeValidDataset(samples) {
  return { version: 2, samples: samples || [makeValidSample()] };
}

// --- real dataset ---------------------------------------------------------

test("the real Dataset v2 validates successfully", () => {
  const dataset = loadRealDatasetV2();
  const result = validateDatasetV2(dataset);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the real Dataset v2 contains exactly the 6 expected sample IDs", () => {
  const dataset = loadRealDatasetV2();
  const ids = dataset.samples.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-5-real-flaky-test",
    "experiment-A-multi-browser-same-signature",
    "experiment-B-multi-browser-different-signatures",
  ]);
});

// --- basic shape -----------------------------------------------------------

test("a well-formed v2 dataset passes validation", () => {
  const result = validateDatasetV2(makeValidDataset());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("an unsupported version fails validation", () => {
  const result = validateDatasetV2({ version: 1, samples: [makeValidSample()] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("dataset.version")));
});

test("duplicate sample ids fail validation", () => {
  const dataset = makeValidDataset([makeValidSample({ id: "dup" }), makeValidSample({ id: "dup" })]);
  const result = validateDatasetV2(dataset);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("duplicate sample id")));
});

test("an invalid classification fails validation", () => {
  const sample = makeValidSample({
    groundTruth: { classification: "NOT_REAL", shouldRetry: false, shouldCreateBug: false },
  });
  const result = validateDatasetV2(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("groundTruth.classification")));
});

// --- correlation.applicable shape ------------------------------------------

test("correlation.applicable not boolean fails validation", () => {
  const sample = makeValidSample({ correlation: { applicable: "yes", observed: null } });
  const result = validateDatasetV2(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlation.applicable")));
});

test("applicable=true with observed missing fails validation", () => {
  const sample = makeValidSample({
    correlation: { applicable: true, observed: null },
    quality: { ...makeValidSample().quality, correlationConstruction: "pass", correlationTransport: "pass", correlationReasoning: "pass" },
  });
  const result = validateDatasetV2(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlation.observed: must be an object")));
});

test("applicable=false with a non-null observed object fails validation", () => {
  const sample = makeValidSample({
    correlation: { applicable: false, observed: makeApplicableCorrelation().observed },
  });
  const result = validateDatasetV2(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlation.observed: must be null")));
});

// --- observed field validation ---------------------------------------------

function applicableSample(observedOverrides, qualityOverrides = {}) {
  return makeValidSample({
    correlation: makeApplicableCorrelation(observedOverrides),
    quality: {
      ...makeValidSample().quality,
      correlationConstruction: "pass",
      correlationTransport: "pass",
      correlationReasoning: "pass",
      ...qualityOverrides,
    },
  });
}

test("invalid browsers (empty array) fails validation", () => {
  const result = validateDatasetV2(makeValidDataset([applicableSample({ browsers: [] })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("observed.browsers")));
});

test("duplicate browser names fail validation", () => {
  const result = validateDatasetV2(makeValidDataset([applicableSample({ browsers: ["chrome", "chrome"] })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("observed.browsers")));
});

test("a failed browser not present in browsers fails validation", () => {
  const result = validateDatasetV2(
    makeValidDataset([applicableSample({ browsers: ["chrome"], failedBrowsers: ["chrome", "edge"], additionalFailedBrowsers: ["edge"] })])
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("observed.failedBrowsers") && e.includes("edge")));
});

test("a passed browser not present in browsers fails validation", () => {
  const result = validateDatasetV2(
    makeValidDataset([applicableSample({ browsers: ["chrome"], failedBrowsers: ["chrome"], passedBrowsers: ["edge"], additionalFailedBrowsers: [], failureScope: "single-browser" })])
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("observed.passedBrowsers") && e.includes("edge")));
});

test("the same browser marked both failed and passed fails validation", () => {
  const result = validateDatasetV2(
    makeValidDataset([
      applicableSample({
        browsers: ["chrome", "edge"],
        failedBrowsers: ["chrome"],
        passedBrowsers: ["chrome"],
        additionalFailedBrowsers: [],
        failureScope: "single-browser",
      }),
    ])
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("cannot be both a failed and a passed browser")));
});

test("an invalid primaryBrowser (not in failedBrowsers) fails validation", () => {
  const result = validateDatasetV2(makeValidDataset([applicableSample({ primaryBrowser: "edge", failedBrowsers: ["chrome"], additionalFailedBrowsers: [], failureScope: "single-browser" })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("observed.primaryBrowser")));
});

test("an invalid additionalFailedBrowsers (includes primaryBrowser) fails validation", () => {
  const result = validateDatasetV2(makeValidDataset([applicableSample({ additionalFailedBrowsers: ["chrome", "edge"] })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("additionalFailedBrowsers: must not include primaryBrowser")));
});

test("an invalid failureScope value fails validation", () => {
  const result = validateDatasetV2(makeValidDataset([applicableSample({ failureScope: "all-browsers" })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("observed.failureScope")));
});

test("failureScope='multi-browser' with only one failed browser fails validation", () => {
  const result = validateDatasetV2(
    makeValidDataset([applicableSample({ failedBrowsers: ["chrome"], additionalFailedBrowsers: [], failureScope: "multi-browser" })])
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"multi-browser" requires more than one failed browser')));
});

test("an invalid sameFailureSignature value fails validation", () => {
  const result = validateDatasetV2(makeValidDataset([applicableSample({ sameFailureSignature: "true" })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("observed.sameFailureSignature")));
});

// --- correlation quality enum + applicability consistency ------------------

test("an invalid correlation quality enum value fails validation", () => {
  const sample = makeValidSample({ quality: { ...makeValidSample().quality, correlationReasoning: "sort_of" } });
  const result = validateDatasetV2(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("quality.correlationReasoning")));
});

test("applicable=false with a non-not_applicable correlation quality field fails validation", () => {
  const sample = makeValidSample({ quality: { ...makeValidSample().quality, correlationConstruction: "pass" } });
  const result = validateDatasetV2(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('correlation.applicable is false but quality.correlationConstruction is "pass"')));
});

test("applicable=true with a not_applicable correlation quality field fails validation", () => {
  const sample = applicableSample({}, { correlationTransport: "not_applicable" });
  const result = validateDatasetV2(makeValidDataset([sample]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('correlation.applicable is true but quality.correlationTransport is "not_applicable"')));
});

// --- v1 dataset is untouched -------------------------------------------------

test("Dataset v1 is unaffected by the v2 schema module (still loads/parses independently)", () => {
  const v1 = loadRealDatasetV1();
  assert.equal(v1.version, 1);
  assert.equal(v1.samples.length, 4);
});

// --- migration integrity ----------------------------------------------------
// The load-bearing invariant of Option B: the four migrated samples' v1
// fields must be byte-identical to the real dataset.json, not re-curated
// during migration. This test must fail if anyone silently "improves" a
// historical value while copying it into dataset-v2.json.

test("migration integrity: the four migrated samples preserve every pre-existing v1 field exactly", () => {
  const v1 = loadRealDatasetV1();
  const v2 = loadRealDatasetV2();
  const v2ById = new Map(v2.samples.map((s) => [s.id, s]));

  assert.equal(v1.samples.length, 4, "expected exactly 4 v1 samples to compare against");

  for (const v1Sample of v1.samples) {
    const v2Sample = v2ById.get(v1Sample.id);
    assert.ok(v2Sample, `Dataset v2 is missing migrated sample "${v1Sample.id}"`);

    // Only pre-existing v1 fields are compared - v2's additive fields
    // (correlation, quality.correlation*) are deliberately excluded here,
    // since they never existed in v1 and are not migration targets.
    assert.deepEqual(v2Sample.id, v1Sample.id);
    assert.deepEqual(v2Sample.scenario, v1Sample.scenario);
    assert.deepEqual(v2Sample.description, v1Sample.description);
    assert.deepEqual(v2Sample.groundTruth, v1Sample.groundTruth);
    assert.deepEqual(v2Sample.actual, v1Sample.actual);
    assert.deepEqual(v2Sample.ambiguity, v1Sample.ambiguity);
    assert.deepEqual(v2Sample.metadata, v1Sample.metadata);

    const { correlationConstruction, correlationTransport, correlationReasoning, ...v2PreExistingQuality } = v2Sample.quality;
    assert.deepEqual(v2PreExistingQuality, v1Sample.quality, `${v1Sample.id}: pre-existing quality fields must match v1 exactly`);
  }
});

test("migration integrity: all four migrated samples have correlation marked not applicable", () => {
  const v2 = loadRealDatasetV2();
  const migratedIds = [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-5-real-flaky-test",
  ];
  const v2ById = new Map(v2.samples.map((s) => [s.id, s]));

  for (const id of migratedIds) {
    const sample = v2ById.get(id);
    assert.equal(sample.correlation.applicable, false, `${id}: correlation.applicable must be false`);
    assert.equal(sample.correlation.observed, null, `${id}: correlation.observed must be null`);
    assert.equal(sample.quality.correlationConstruction, "not_applicable", `${id}: correlationConstruction must be not_applicable`);
    assert.equal(sample.quality.correlationTransport, "not_applicable", `${id}: correlationTransport must be not_applicable`);
    assert.equal(sample.quality.correlationReasoning, "not_applicable", `${id}: correlationReasoning must be not_applicable`);
  }
});

test("migration integrity: Scenario A is encoded with the verified correlation/AI-result values", () => {
  const v2 = loadRealDatasetV2();
  const sample = v2.samples.find((s) => s.id === "experiment-A-multi-browser-same-signature");
  assert.ok(sample, "Scenario A sample must exist");

  assert.deepEqual(sample.correlation, {
    applicable: true,
    observed: {
      browsers: ["chrome", "edge"],
      failedBrowsers: ["chrome", "edge"],
      passedBrowsers: [],
      primaryBrowser: "chrome",
      additionalFailedBrowsers: ["edge"],
      failureScope: "multi-browser",
      sameFailureSignature: true,
    },
  });
  assert.equal(sample.actual.classification, "TEST_BUG");
  assert.equal(sample.actual.confidence, 0.95);
  assert.equal(sample.actual.shouldRetry, false);
  assert.equal(sample.actual.finalShouldCreateBug, false);
  assert.equal(sample.quality.correlationConstruction, "pass");
  assert.equal(sample.quality.correlationTransport, "pass");
  assert.equal(sample.quality.correlationReasoning, "partial");
  assert.equal(sample.metadata.PR, 35);
  assert.equal(sample.metadata.workflowRun, 32039821199);
  assert.equal(sample.metadata.controlledFailureSha, "f68e978e959dd7abb24d422b45c18bead0f361a1");
  assert.equal(sample.metadata.revertSha, "85eebea70f5e3feef8c6cdd6c62b7c78f5b959d3");
});

test("migration integrity: Scenario B is encoded with the verified correlation/AI-result values", () => {
  const v2 = loadRealDatasetV2();
  const sample = v2.samples.find((s) => s.id === "experiment-B-multi-browser-different-signatures");
  assert.ok(sample, "Scenario B sample must exist");

  assert.deepEqual(sample.correlation, {
    applicable: true,
    observed: {
      browsers: ["chrome", "edge"],
      failedBrowsers: ["chrome", "edge"],
      passedBrowsers: [],
      primaryBrowser: "chrome",
      additionalFailedBrowsers: ["edge"],
      failureScope: "multi-browser",
      sameFailureSignature: false,
    },
  });
  assert.equal(sample.actual.classification, "TEST_BUG");
  assert.equal(sample.actual.confidence, 0.92);
  assert.equal(sample.actual.shouldRetry, false);
  assert.equal(sample.actual.finalShouldCreateBug, false);
  assert.equal(sample.quality.correlationConstruction, "pass");
  assert.equal(sample.quality.correlationTransport, "pass");
  assert.equal(sample.quality.correlationReasoning, "partial");
  assert.equal(sample.metadata.PR, 36);
  assert.equal(sample.metadata.workflowRun, 32041197768);
  assert.equal(sample.metadata.controlledFailureSha, "acb7baf771a9c666cd5db648ab611800abbb599b");
  assert.equal(sample.metadata.revertSha, "7bbb28713ec76ad97cd37550a02dfd3728de4909");
});
