"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { formatEvaluationSummaryV2, formatPercentage, run } = require("./evaluate-v2");
const { evaluateDatasetV2 } = require("./scoring-v2");

const DATASET_V2_PATH = path.join(__dirname, "dataset-v2.json");

test("formatPercentage: renders one decimal place", () => {
  assert.equal(formatPercentage(0.8), "80.0%");
  assert.equal(formatPercentage(5 / 6), "83.3%");
  assert.equal(formatPercentage(1), "100.0%");
});

test("formatPercentage: null renders as N/A", () => {
  assert.equal(formatPercentage(null), "N/A");
});

test("formatEvaluationSummaryV2: includes Correlation section computed from the real dataset", () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf8"));
  const evaluation = evaluateDatasetV2(dataset);
  const output = formatEvaluationSummaryV2(evaluation);

  assert.match(output, /QA Agent Evaluation — Dataset v2/);
  assert.match(output, /Samples\n\s+Total: 6/);
  assert.match(output, /Classification\n\s+Correct: 4/);
  assert.match(output, /Accuracy: 80\.0%/);
  assert.match(output, /shouldRetry\n\s+Correct: 5/);
  assert.match(output, /Accuracy: 83\.3%/);
  assert.match(output, /shouldCreateBug\n\s+Correct: 6/);
  assert.match(output, /Accuracy: 100\.0%/);
  assert.match(output, /Evidence grounding\n\s+Fabricated\/unsupported evidence finding:\n\s+No: 6\n\s+Yes: 0/);
  assert.match(output, /Correlation\n\s+Applicable samples: 2/);
  assert.match(output, /Construction:\n\s+pass: 2\n\s+partial: 0\n\s+fail: 0\n\s+not_applicable: 4/);
  assert.match(output, /Transport:\n\s+pass: 2/);
  assert.match(output, /Reasoning:\n\s+pass: 0\n\s+partial: 2/);
  assert.match(output, /Classification mismatches\n\s+- experiment-2-broken-selector: expected TEST_BUG, got FLAKY_TEST/);
  assert.match(output, /Ambiguous classifications\n\s+- experiment-5-real-flaky-test/);
});

test("run(): the real dataset-v2.json returns exit code 0 with a human-readable report", () => {
  const result = run(DATASET_V2_PATH, { json: false });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /QA Agent Evaluation — Dataset v2/);
});

test("run(): --json mode produces valid, parseable JSON metrics including the correlation block", () => {
  const result = run(DATASET_V2_PATH, { json: true });
  assert.equal(result.exitCode, 0);
  const metrics = JSON.parse(result.output);
  assert.equal(metrics.totalSamples, 6);
  assert.equal(metrics.correlation.applicable, 2);
  assert.equal(metrics.correlation.reasoning.partial, 2);
});

test("run(): an invalid dataset fails validation and exits non-zero instead of scoring", () => {
  const tmpPath = path.join(os.tmpdir(), `invalid-dataset-v2-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ version: 2, samples: [{ id: "broken" }] }), "utf8");
  try {
    const result = run(tmpPath, { json: false });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /failed validation/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test("offline guarantee: neither evaluate-v2.js nor scoring-v2.js actually use AI providers, credentials, or network calls", () => {
  const evaluateSource = fs.readFileSync(path.join(__dirname, "evaluate-v2.js"), "utf8");
  const scoringSource = fs.readFileSync(path.join(__dirname, "scoring-v2.js"), "utf8");
  const combined = evaluateSource + scoringSource;

  const forbiddenPatterns = [
    /require\([^)]*providers/,
    /createProvider\s*\(/,
    /process\.env\.AI_API_KEY/,
    /process\.env\.GROQ_API_KEY/,
    /\bfetch\s*\(/,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(combined), `expected no match for ${pattern} in the v2 evaluation runner`);
  }
});
