"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateBaseline } = require("./baseline-schema");

const BASELINE_PATH = path.join(__dirname, "baseline-v1.json");

function loadRealBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

function makeValidBaseline(overrides) {
  const base = {
    version: 1,
    datasetVersion: 1,
    samples: {
      "sample-1": { classificationStatus: "pass", shouldRetryCorrect: true, shouldCreateBugCorrect: true },
    },
  };
  return { ...base, ...overrides };
}

test("the real baseline-v1.json validates successfully", () => {
  const baseline = loadRealBaseline();
  const result = validateBaseline(baseline);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the real baseline-v1.json contains exactly the 4 expected sample IDs", () => {
  const baseline = loadRealBaseline();
  const ids = Object.keys(baseline.samples).sort();
  assert.deepEqual(ids, [
    "experiment-2-broken-selector",
    "experiment-3-application-like-mismatch",
    "experiment-4-deterministic-test-bug-history",
    "experiment-5-real-flaky-test",
  ]);
});

test("a well-formed baseline passes validation", () => {
  const result = validateBaseline(makeValidBaseline());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("an unsupported version fails validation", () => {
  const result = validateBaseline(makeValidBaseline({ version: 2 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline.version")));
});

test("a missing datasetVersion fails validation", () => {
  const baseline = makeValidBaseline();
  delete baseline.datasetVersion;
  const result = validateBaseline(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("datasetVersion")));
});

test("an invalid classificationStatus fails validation", () => {
  const result = validateBaseline(
    makeValidBaseline({
      samples: { "sample-1": { classificationStatus: "sort_of", shouldRetryCorrect: true, shouldCreateBugCorrect: true } },
    })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("classificationStatus")));
});

test("an invalid shouldRetryCorrect boolean fails validation", () => {
  const result = validateBaseline(
    makeValidBaseline({
      samples: { "sample-1": { classificationStatus: "pass", shouldRetryCorrect: "yes", shouldCreateBugCorrect: true } },
    })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("shouldRetryCorrect")));
});

test("an invalid shouldCreateBugCorrect boolean fails validation", () => {
  const result = validateBaseline(
    makeValidBaseline({
      samples: { "sample-1": { classificationStatus: "pass", shouldRetryCorrect: true, shouldCreateBugCorrect: "no" } },
    })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("shouldCreateBugCorrect")));
});

test("missing samples object fails validation", () => {
  const baseline = makeValidBaseline();
  delete baseline.samples;
  const result = validateBaseline(baseline);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline.samples")));
});

test("an empty samples object fails validation", () => {
  const result = validateBaseline(makeValidBaseline({ samples: {} }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("must contain at least one sample")));
});

test("a non-object baseline fails validation", () => {
  const result = validateBaseline(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("baseline: must be an object")));
});
