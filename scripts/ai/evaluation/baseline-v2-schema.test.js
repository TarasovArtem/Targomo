"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateBaselineV2 } = require("./baseline-v2-schema");

const BASELINE_V2_PATH = path.join(__dirname, "baseline-v2.json");

function loadRealBaselineV2() {
  return JSON.parse(fs.readFileSync(BASELINE_V2_PATH, "utf8"));
}

function makeValidBaseline(overrides = {}) {
  const base = {
    version: 1,
    datasetVersion: 2,
    samples: {
      "sample-1": {
        classificationStatus: "pass",
        shouldRetryCorrect: true,
        shouldCreateBugCorrect: true,
        correlationConstruction: "not_applicable",
        correlationTransport: "not_applicable",
        correlationReasoning: "not_applicable",
      },
    },
  };
  return { ...base, ...overrides };
}

test("the real baseline-v2.json validates successfully", () => {
  const baseline = loadRealBaselineV2();
  const result = validateBaselineV2(baseline);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the real baseline-v2.json contains exactly the 6 expected sample IDs", () => {
  const baseline = loadRealBaselineV2();
  const ids = Object.keys(baseline.samples).sort();
  assert.deepEqual(ids, [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-5-real-flaky-test",
    "experiment-A-multi-browser-same-signature",
    "experiment-B-multi-browser-different-signatures",
  ]);
});

test("a well-formed baseline v2 passes validation", () => {
  const result = validateBaselineV2(makeValidBaseline());
  assert.equal(result.valid, true);
});

test("an unsupported version fails validation", () => {
  const result = validateBaselineV2(makeValidBaseline({ version: 2 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline.version")));
});

test("an invalid datasetVersion (not 2) fails validation", () => {
  const result = validateBaselineV2(makeValidBaseline({ datasetVersion: 1 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline.datasetVersion")));
});

test("an invalid classificationStatus fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], classificationStatus: "sort_of" } },
  });
  const result = validateBaselineV2(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("classificationStatus")));
});

test("an invalid action-correctness type fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], shouldRetryCorrect: "yes" } },
  });
  const result = validateBaselineV2(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("shouldRetryCorrect")));
});

test("an invalid correlation quality state fails validation", () => {
  const baseline = makeValidBaseline({
    samples: { "sample-1": { ...makeValidBaseline().samples["sample-1"], correlationReasoning: "kinda" } },
  });
  const result = validateBaselineV2(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("correlationReasoning")));
});

test("a malformed sample (not an object) fails validation", () => {
  const baseline = makeValidBaseline({ samples: { "sample-1": "not-an-object" } });
  const result = validateBaselineV2(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('samples["sample-1"]: must be an object')));
});
