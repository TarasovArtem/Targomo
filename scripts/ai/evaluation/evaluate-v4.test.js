"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { formatEvaluationSummaryV4, formatPercentage, run } = require("./evaluate-v4");
const { evaluateDatasetV4 } = require("./scoring-v4");

const DATASET_V4_PATH = path.join(__dirname, "dataset-v4.json");

test("formatPercentage: renders one decimal place", () => {
  assert.equal(formatPercentage(0.8), "80.0%");
  assert.equal(formatPercentage(7 / 8), "87.5%");
  assert.equal(formatPercentage(1), "100.0%");
});

test("formatPercentage: null renders as N/A", () => {
  assert.equal(formatPercentage(null), "N/A");
});

test("formatEvaluationSummaryV4: includes Evidence grounding and Correlation sections computed from the real dataset", () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET_V4_PATH, "utf8"));
  const evaluation = evaluateDatasetV4(dataset);
  const output = formatEvaluationSummaryV4(evaluation);

  assert.match(output, /QA Agent Evaluation — Dataset v4/);
  assert.match(output, /Samples\n\s+Total: 9/);
  assert.match(output, /Classification\n\s+Correct: 7/);
  assert.match(output, /Accuracy: 87\.5%/);
  assert.match(output, /shouldRetry\n\s+Correct: 8/);
  assert.match(output, /shouldCreateBug\n\s+Correct: 9/);
  assert.match(output, /Accuracy: 100\.0%/);
  assert.match(output, /Evidence grounding\n\s+Fabricated\/unsupported evidence finding:\n\s+No: 8\n\s+Yes: 1/);
  assert.match(output, /Correlation\n\s+Applicable samples: 5/);
  assert.match(output, /Construction:\n\s+pass: 5\n\s+partial: 0\n\s+fail: 0\n\s+not_applicable: 4/);
  assert.match(output, /Transport:\n\s+pass: 5/);
  assert.match(output, /Reasoning:\n\s+pass: 2\n\s+partial: 2\n\s+fail: 1/);
  assert.match(output, /Classification mismatches\n\s+- experiment-2-broken-selector: expected TEST_BUG, got FLAKY_TEST/);
  assert.match(output, /Ambiguous classifications\n\s+- experiment-5-real-flaky-test/);
});

test("run(): the real dataset-v4.json returns exit code 0 with a human-readable report", () => {
  const result = run(DATASET_V4_PATH, { json: false });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /QA Agent Evaluation — Dataset v4/);
});

test("run(): --json mode produces valid, parseable JSON metrics including evidenceGrounding and correlation blocks", () => {
  const result = run(DATASET_V4_PATH, { json: true });
  assert.equal(result.exitCode, 0);
  const metrics = JSON.parse(result.output);
  assert.equal(metrics.totalSamples, 9);
  assert.equal(metrics.evidenceGrounding.fabricatedEvidence.true, 1);
  assert.equal(metrics.correlation.applicable, 5);
  assert.equal(metrics.correlation.reasoning.fail, 1);
  assert.equal(metrics.correlation.reasoning.pass, 2);
});

test("run(): an invalid dataset fails validation and exits non-zero instead of scoring", () => {
  const tmpPath = path.join(os.tmpdir(), `invalid-dataset-v4-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ version: 4, samples: [{ id: "broken" }] }), "utf8");
  try {
    const result = run(tmpPath, { json: false });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /failed validation/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test("offline guarantee: neither evaluate-v4.js nor scoring-v4.js actually use AI providers, credentials, or network calls", () => {
  const evaluateSource = fs.readFileSync(path.join(__dirname, "evaluate-v4.js"), "utf8");
  const scoringSource = fs.readFileSync(path.join(__dirname, "scoring-v4.js"), "utf8");
  const combined = evaluateSource + scoringSource;

  const forbiddenPatterns = [
    /require\([^)]*providers/,
    /createProvider\s*\(/,
    /process\.env\.AI_API_KEY/,
    /process\.env\.GROQ_API_KEY/,
    /\bfetch\s*\(/,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(combined), `expected no match for ${pattern} in the v4 evaluation runner`);
  }
});
