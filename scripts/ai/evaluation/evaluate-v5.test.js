"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { run } = require("./evaluate-v5");

const DATASET_PATH = path.join(__dirname, "dataset-v5.json");

test("run(): exitCode 0 for the real dataset-v5.json, human-readable output", () => {
  const result = run(DATASET_PATH, { json: false });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /QA Agent Evaluation — Dataset v5/);
  assert.match(result.output, /Total \(scorable\): 13/);
  assert.match(result.output, /Historical-only \(not scored\): 1/);
});

test("run(): --json output is valid JSON containing the new v5 metrics", () => {
  const result = run(DATASET_PATH, { json: true });
  assert.equal(result.exitCode, 0);
  const metrics = JSON.parse(result.output);
  assert.equal(metrics.totalSamples, 13);
  assert.ok("modelShouldCreateBugCorrect" in metrics);
  assert.ok("knowledge" in metrics);
  assert.ok("knowledgeUsage" in metrics.qualitative);
  assert.ok("knowledgeGrounding" in metrics.qualitative);
  assert.ok("inferenceQuality" in metrics.qualitative);
});

test("run(): fails cleanly on invalid dataset without throwing", () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const tmpPath = path.join(os.tmpdir(), `invalid-dataset-v5-${process.pid}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ version: 5, samples: [{ id: "" }] }));
  try {
    const result = run(tmpPath, {});
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /failed validation/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});
