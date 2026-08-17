"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { formatEvaluationSummary, formatPercentage, run } = require("./evaluate");
const { evaluateDataset } = require("./scoring");

const DATASET_PATH = path.join(__dirname, "dataset.json");

test("formatPercentage: renders one decimal place", () => {
  assert.equal(formatPercentage(2 / 3), "66.7%");
  assert.equal(formatPercentage(0.75), "75.0%");
  assert.equal(formatPercentage(1), "100.0%");
  assert.equal(formatPercentage(0), "0.0%");
});

test("formatPercentage: null renders as N/A, never NaN%", () => {
  assert.equal(formatPercentage(null), "N/A");
});

test("formatEvaluationSummary: includes all top-level sections and reports mismatches/ambiguous samples", () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, "utf8"));
  const evaluation = evaluateDataset(dataset);
  const output = formatEvaluationSummary(evaluation);

  assert.match(output, /QA Agent Evaluation — Dataset v1/);
  assert.match(output, /Samples\n\s+Total: 4/);
  assert.match(output, /Classification\n\s+Correct: 2/);
  assert.match(output, /Accuracy: 66\.7%/);
  assert.match(output, /shouldRetry\n\s+Correct: 3/);
  assert.match(output, /shouldCreateBug\n\s+Correct: 4/);
  assert.match(output, /Policy\n\s+Interventions: 0/);
  assert.match(output, /Classification mismatches\n\s+- experiment-2-broken-selector: expected TEST_BUG, got FLAKY_TEST/);
  assert.match(output, /shouldRetry mismatches\n\s+- experiment-2-broken-selector/);
  assert.match(output, /Ambiguous classifications\n\s+- experiment-5-real-flaky-test: expected FLAKY_TEST, actual EXTERNAL_DEPENDENCY/);
  // No shouldCreateBug mismatches in the real dataset - section must not appear.
  assert.doesNotMatch(output, /shouldCreateBug mismatches/);
});

test("run(): scores the real dataset.json and returns exit code 0 with a human-readable report", () => {
  const result = run(DATASET_PATH, { json: false });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /QA Agent Evaluation — Dataset v1/);
});

test("run(): --json mode produces valid, parseable JSON metrics", () => {
  const result = run(DATASET_PATH, { json: true });
  assert.equal(result.exitCode, 0);
  const metrics = JSON.parse(result.output);
  assert.equal(metrics.totalSamples, 4);
  assert.equal(metrics.classificationScorable, 3);
  assert.equal(metrics.classificationAmbiguous, 1);
});

test("run(): an invalid dataset fails validation and exits non-zero instead of scoring", () => {
  const tmpPath = path.join(os.tmpdir(), `invalid-dataset-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, samples: [{ id: "broken" }] }), "utf8");
  try {
    const result = run(tmpPath, { json: false });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /failed validation/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test("offline guarantee: neither evaluate.js nor scoring.js actually use AI providers, credentials, or network calls", () => {
  const evaluateSource = fs.readFileSync(path.join(__dirname, "evaluate.js"), "utf8");
  const scoringSource = fs.readFileSync(path.join(__dirname, "scoring.js"), "utf8");
  const combined = evaluateSource + scoringSource;

  // Checks actual usage (require calls, env reads, network calls), not bare
  // substrings - both files' comments legitimately mention these names
  // (e.g. "does not import GroqProvider") while explaining why they're
  // absent, so a plain includes() check would flag its own documentation.
  const forbiddenPatterns = [
    /require\([^)]*providers/,
    /createProvider\s*\(/,
    /process\.env\.AI_API_KEY/,
    /process\.env\.GROQ_API_KEY/,
    /\bfetch\s*\(/,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(combined), `expected no match for ${pattern} in the evaluation runner`);
  }
});
