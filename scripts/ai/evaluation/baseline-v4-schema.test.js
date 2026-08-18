"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateBaselineV4 } = require("./baseline-v4-schema");

const BASELINE_V4_PATH = path.join(__dirname, "baseline-v4.json");
const BASELINE_V3_PATH = path.join(__dirname, "baseline-v3.json");

function loadRealBaselineV4() {
  return JSON.parse(fs.readFileSync(BASELINE_V4_PATH, "utf8"));
}

function loadRealBaselineV3() {
  return JSON.parse(fs.readFileSync(BASELINE_V3_PATH, "utf8"));
}

function makeValidBaseline(overrides = {}) {
  const base = {
    version: 1,
    datasetVersion: 4,
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

test("the real baseline-v4.json validates successfully", () => {
  const baseline = loadRealBaselineV4();
  const result = validateBaselineV4(baseline);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the real baseline-v4.json contains exactly the 9 expected sample IDs", () => {
  const baseline = loadRealBaselineV4();
  const ids = Object.keys(baseline.samples).sort();
  assert.deepEqual(ids, [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-41-correlation-necessary-grounding",
    "experiment-45-post-prompt-grounding-revalidation",
    "experiment-47-post-prompt-grounding-revalidation",
    "experiment-5-real-flaky-test",
    "experiment-A-multi-browser-same-signature",
    "experiment-B-multi-browser-different-signatures",
  ]);
});

test("migration integrity: every Baseline v3 sample state is deeply equal in Baseline v4", () => {
  const v3 = loadRealBaselineV3();
  const v4 = loadRealBaselineV4();
  for (const id of Object.keys(v3.samples)) {
    assert.ok(v4.samples[id], `expected Baseline v4 to contain migrated sample "${id}"`);
    assert.deepEqual(v4.samples[id], v3.samples[id], `Baseline v4's "${id}" must be identical to Baseline v3's`);
  }
});

test("the two new post-prompt samples freeze the expected pass/pass/pass/false baseline state", () => {
  const baseline = loadRealBaselineV4();
  for (const id of ["experiment-45-post-prompt-grounding-revalidation", "experiment-47-post-prompt-grounding-revalidation"]) {
    const sample = baseline.samples[id];
    assert.ok(sample, `expected Baseline v4 to contain "${id}"`);
    assert.equal(sample.classificationStatus, "pass");
    assert.equal(sample.shouldRetryCorrect, true);
    assert.equal(sample.shouldCreateBugCorrect, true);
    assert.equal(sample.fabricatedEvidence, false);
    assert.equal(sample.rootCause, "pass");
    assert.equal(sample.evidence, "pass");
    assert.equal(sample.recommendedFix, "pass");
    assert.equal(sample.correlationConstruction, "pass");
    assert.equal(sample.correlationTransport, "pass");
    assert.equal(sample.correlationReasoning, "pass");
  }
});

test("Experiment #41's frozen baseline state matches the curated Experiment #41 finding", () => {
  const baseline = loadRealBaselineV4();
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

test("a well-formed baseline v4 passes validation", () => {
  const result = validateBaselineV4(makeValidBaseline());
  assert.equal(result.valid, true);
});

test("an unsupported version fails validation", () => {
  const result = validateBaselineV4(makeValidBaseline({ version: 2 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline.version")));
});

test("an invalid datasetVersion (not 4) fails validation", () => {
  const result = validateBaselineV4(makeValidBaseline({ datasetVersion: 3 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline.datasetVersion")));
});

test("an invalid classificationStatus fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], classificationStatus: "sort_of" } },
  });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("classificationStatus")));
});

test("an invalid action-correctness type fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], shouldRetryCorrect: "yes" } },
  });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("shouldRetryCorrect")));
});

test("an invalid correlation quality state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], correlationReasoning: "kinda" } },
  });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlationReasoning")));
});

test("a missing fabricatedEvidence fails validation", () => {
  const sample = { ...makeValidBaseline().samples["sample-1"] };
  delete sample.fabricatedEvidence;
  const baseline = makeValidBaseline({ samples: { "sample-1": sample } });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("fabricatedEvidence")));
});

test("an invalid rootCause state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], rootCause: "kinda" } },
  });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("rootCause")));
});

test("an invalid evidence state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], evidence: "kinda" } },
  });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("evidence")));
});

test("an invalid recommendedFix state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], recommendedFix: "kinda" } },
  });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("recommendedFix")));
});

test("an invalid fabricatedEvidence boolean fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], fabricatedEvidence: "false" } },
  });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("fabricatedEvidence")));
});

test("a malformed sample (not an object) fails validation", () => {
  const baseline = makeValidBaseline({ samples: { "sample-1": "not-an-object" } });
  const result = validateBaselineV4(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('samples["sample-1"]: must be an object')));
});
