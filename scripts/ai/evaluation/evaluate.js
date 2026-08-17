/**
 * Thin CLI wrapper around scoring.js: loads dataset.json from disk,
 * validates it with the existing Phase 1 validator, scores it, and prints a
 * human-readable (or, with --json, machine-readable) report.
 *
 * This is the only file in scripts/ai/evaluation/ that touches the
 * filesystem or process.exit/console - evaluateDataset() itself
 * (scoring.js) stays pure so it can be unit tested without any I/O.
 *
 * Deliberately does not import GroqProvider/MockProvider/createProvider and
 * never reads AI_API_KEY/GROQ_API_KEY: this only re-scores results already
 * recorded in the dataset, it never calls an AI provider.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { validateDataset } = require("./dataset-schema");
const { evaluateDataset } = require("./scoring");

const DEFAULT_DATASET_PATH = path.join(__dirname, "dataset.json");

function formatPercentage(value) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function formatQualitativeLine(label, counts) {
  const parts = Object.entries(counts).map(([key, count]) => `${key}=${count}`);
  return `  ${label}: ${parts.join(" ")}`;
}

// Pure formatting: takes the { metrics, samples } shape evaluateDataset()
// returns and produces a plain-text report. No I/O, so it's directly
// testable against fixed metrics objects.
function formatEvaluationSummary({ metrics, samples }) {
  const lines = [];

  lines.push("QA Agent Evaluation — Dataset v1");
  lines.push("");
  lines.push("Samples");
  lines.push(`  Total: ${metrics.totalSamples}`);
  lines.push(`  Classification scorable: ${metrics.classificationScorable}`);
  lines.push(`  Ambiguous: ${metrics.classificationAmbiguous}`);
  lines.push("");
  lines.push("Classification");
  lines.push(`  Correct: ${metrics.classificationCorrect}`);
  lines.push(`  Incorrect: ${metrics.classificationIncorrect}`);
  lines.push(`  Accuracy: ${formatPercentage(metrics.classificationAccuracy)}`);
  lines.push("");
  lines.push("shouldRetry");
  lines.push(`  Correct: ${metrics.shouldRetryCorrect}`);
  lines.push(`  Incorrect: ${metrics.shouldRetryIncorrect}`);
  lines.push(`  Accuracy: ${formatPercentage(metrics.shouldRetryAccuracy)}`);
  lines.push("");
  lines.push("shouldCreateBug");
  lines.push(`  Correct: ${metrics.shouldCreateBugCorrect}`);
  lines.push(`  Incorrect: ${metrics.shouldCreateBugIncorrect}`);
  lines.push(`  Accuracy: ${formatPercentage(metrics.shouldCreateBugAccuracy)}`);
  lines.push("");
  lines.push("Policy");
  lines.push(`  Interventions: ${metrics.policyInterventions}`);
  lines.push("");
  lines.push("Qualitative");
  lines.push(formatQualitativeLine("rootCause", metrics.qualitative.rootCause));
  lines.push(formatQualitativeLine("evidence", metrics.qualitative.evidence));
  lines.push(formatQualitativeLine("recommendedFix", metrics.qualitative.recommendedFix));
  lines.push(formatQualitativeLine("historyUsage", metrics.qualitative.historyUsage));

  const classificationMismatches = samples.filter((s) => s.classification.status === "incorrect");
  if (classificationMismatches.length > 0) {
    lines.push("");
    lines.push("Classification mismatches");
    for (const sample of classificationMismatches) {
      lines.push(`  - ${sample.id}: expected ${sample.classification.expected}, got ${sample.classification.actual}`);
    }
  }

  const shouldRetryMismatches = samples.filter((s) => !s.shouldRetry.correct);
  if (shouldRetryMismatches.length > 0) {
    lines.push("");
    lines.push("shouldRetry mismatches");
    for (const sample of shouldRetryMismatches) {
      lines.push(`  - ${sample.id}`);
    }
  }

  const shouldCreateBugMismatches = samples.filter((s) => !s.shouldCreateBug.correct);
  if (shouldCreateBugMismatches.length > 0) {
    lines.push("");
    lines.push("shouldCreateBug mismatches");
    for (const sample of shouldCreateBugMismatches) {
      lines.push(`  - ${sample.id}`);
    }
  }

  const ambiguousSamples = samples.filter((s) => s.isAmbiguous);
  if (ambiguousSamples.length > 0) {
    lines.push("");
    lines.push("Ambiguous classifications");
    for (const sample of ambiguousSamples) {
      lines.push(`  - ${sample.id}: expected ${sample.classification.expected}, actual ${sample.classification.actual}`);
    }
  }

  return lines.join("\n");
}

// Testable core: no console.log/process.exit here, just inputs to outputs,
// so evaluate.test.js can assert on { exitCode, output } directly instead
// of shelling out to a child process.
function run(datasetPath, options) {
  const json = Boolean(options && options.json);

  const raw = fs.readFileSync(datasetPath, "utf8");
  const dataset = JSON.parse(raw);

  const validation = validateDataset(dataset);
  if (!validation.valid) {
    const output = ["Dataset v1 failed validation:", ...validation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const evaluation = evaluateDataset(dataset);
  const output = json ? JSON.stringify(evaluation.metrics, null, 2) : formatEvaluationSummary(evaluation);

  return { exitCode: 0, output };
}

function main() {
  const json = process.argv.includes("--json");
  const result = run(DEFAULT_DATASET_PATH, { json });
  if (result.exitCode === 0) {
    console.log(result.output);
  } else {
    console.error(result.output);
  }
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main();
}

module.exports = { formatEvaluationSummary, formatPercentage, run };
