"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateBaselineV3 } = require("./baseline-v3-schema");

const BASELINE_V3_PATH = path.join(__dirname, "baseline-v3.json");
const BASELINE_V2_PATH = path.join(__dirname, "baseline-v2.json");

function loadRealBaselineV3() {
  return JSON.parse(fs.readFileSync(BASELINE_V3_PATH, "utf8"));
}

function loadRealBaselineV2() {
  return JSON.parse(fs.readFileSync(BASELINE_V2_PATH, "utf8"));
}

function makeValidBaseline(overrides = {}) {
  const base = {
    version: 1,
    datasetVersion: 3,
    samples: {
      "sample-1": {
        classificationStatus: "pass",
        shouldRetryCorrect: true,
        shouldCreateBugCorrect: true,
        fabricatedEvidence: false,
        rootCause: "pass",
        evidence: "pass",
        recommendedFix: "pass",
        correlationConstruction: "not_applicable",
        correlationTransport: "not_applicable",
        correlationReasoning: "not_applicable",
      },
    },
  };
  return { ...base, ...overrides };
}

test("the real baseline-v3.json validates successfully", () => {
  const baseline = loadRealBaselineV3();
  const result = validateBaselineV3(baseline);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the real baseline-v3.json contains exactly the 7 expected sample IDs", () => {
  const baseline = loadRealBaselineV3();
  const ids = Object.keys(baseline.samples).sort();
  assert.deepEqual(ids, [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-41-correlation-necessary-grounding",
    "experiment-5-real-flaky-test",
    "experiment-A-multi-browser-same-signature",
    "experiment-B-multi-browser-different-signatures",
  ]);
});

test("migration integrity: every Baseline v2 sample state is deeply equal in Baseline v3", () => {
  const v2 = loadRealBaselineV2();
  const v3 = loadRealBaselineV3();
  for (const id of Object.keys(v2.samples)) {
    assert.ok(v3.samples[id], `expected Baseline v3 to contain migrated sample "${id}"`);
    assert.deepEqual(v3.samples[id], v2.samples[id], `Baseline v3's "${id}" must be identical to Baseline v2's`);
  }
});

test("Experiment #41's frozen baseline state matches the curated Experiment #41 finding", () => {
  const baseline = loadRealBaselineV3();
  const exp41 = baseline.samples["experiment-41-correlation-necessary-grounding"];
  assert.equal(exp41.classificationStatus, "pass");
  assert.equal(exp41.shouldRetryCorrect, true);
  assert.equal(exp41.shouldCreateBugCorrect, true);
  assert.equal(exp41.fabricatedEvidence, true);
  assert.equal(exp41.rootCause, "fail");
  assert.equal(exp41.evidence, "fail");
  assert.equal(exp41.recommendedFix, "partial");
  assert.equal(exp41.correlationConstruction, "pass");
  assert.equal(exp41.correlationTransport, "pass");
  assert.equal(exp41.correlationReasoning, "fail");
});

test("a well-formed baseline v3 passes validation", () => {
  const result = validateBaselineV3(makeValidBaseline());
  assert.equal(result.valid, true);
});

test("an unsupported version fails validation", () => {
  const result = validateBaselineV3(makeValidBaseline({ version: 2 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline.version")));
});

test("an invalid datasetVersion (not 3) fails validation", () => {
  const result = validateBaselineV3(makeValidBaseline({ datasetVersion: 2 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline.datasetVersion")));
});

test("an invalid classificationStatus fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], classificationStatus: "sort_of" } },
  });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("classificationStatus")));
});

test("an invalid action-correctness type fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], shouldRetryCorrect: "yes" } },
  });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("shouldRetryCorrect")));
});

test("an invalid correlation quality state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], correlationReasoning: "kinda" } },
  });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlationReasoning")));
});

test("a missing fabricatedEvidence fails validation", () => {
  const sample = { ...makeValidBaseline().samples["sample-1"] };
  delete sample.fabricatedEvidence;
  const baseline = makeValidBaseline({ samples: { "sample-1": sample } });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("fabricatedEvidence")));
});

test("an invalid rootCause state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], rootCause: "kinda" } },
  });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("rootCause")));
});

test("an invalid evidence state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], evidence: "kinda" } },
  });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("evidence")));
});

test("an invalid recommendedFix state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], recommendedFix: "kinda" } },
  });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("recommendedFix")));
});

test("an invalid fabricatedEvidence boolean fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], fabricatedEvidence: "false" } },
  });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("fabricatedEvidence")));
});

test("a malformed sample (not an object) fails validation", () => {
  const baseline = makeValidBaseline({ samples: { "sample-1": "not-an-object" } });
  const result = validateBaselineV3(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('samples["sample-1"]: must be an object')));
});
