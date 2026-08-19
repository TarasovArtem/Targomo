/**
 * Thin CLI wrapper around scoring-v5.js: loads dataset-v5.json from disk,
 * validates it with dataset-v5-schema.js, scores it, and prints a
 * human-readable (or, with --json, machine-readable) report.
 *
 * Mirrors evaluate-v4.js's shape exactly, on purpose - this is the only
 * file in scripts/ai/evaluation/ that touches the filesystem or
 * process.exit/console for Dataset v5, and evaluateDatasetV5() itself stays
 * pure so it can be unit tested without any I/O.
 *
 * Deliberately does not import GroqProvider/MockProvider/createProvider and
 * never reads AI_API_KEY/GROQ_API_KEY: this only re-scores results already
 * recorded in the dataset, it never calls an AI provider.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { validateDatasetV5 } = require("./dataset-v5-schema");
const { evaluateDatasetV5 } = require("./scoring-v5");

const DEFAULT_DATASET_PATH = path.join(__dirname, "dataset-v5.json");

function formatPercentage(value) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function formatQualitativeLine(label, counts) {
  const parts = Object.entries(counts).map(([key, count]) => `${key}=${count}`);
  return `  ${label}: ${parts.join(" ")}`;
}

function formatEvaluationSummaryV5({ metrics, samples }, dataset) {
  const lines = [];

  lines.push("QA Agent Evaluation — Dataset v5");
  lines.push("");
  lines.push("Samples");
  lines.push(`  Total (scorable): ${metrics.totalSamples}`);
  lines.push(`  Historical-only (not scored): ${(dataset.historicalObservations || []).length}`);
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
  lines.push("shouldCreateBug (final, post-policy)");
  lines.push(`  Correct: ${metrics.shouldCreateBugCorrect}`);
  lines.push(`  Incorrect: ${metrics.shouldCreateBugIncorrect}`);
  lines.push(`  Accuracy: ${formatPercentage(metrics.shouldCreateBugAccuracy)}`);
  lines.push("");
  lines.push("modelShouldCreateBugCorrect (raw, pre-policy)");
  lines.push(`  Correct: ${metrics.modelShouldCreateBugCorrect}`);
  lines.push(`  Incorrect: ${metrics.modelShouldCreateBugIncorrect}`);
  lines.push(`  Not evaluated: ${metrics.modelShouldCreateBugNotEvaluated}`);
  lines.push(`  Accuracy (of evaluated): ${formatPercentage(metrics.modelShouldCreateBugAccuracy)}`);
  lines.push("");
  lines.push("Policy");
  lines.push(`  Interventions: ${metrics.policyInterventions}`);
  lines.push("");
  lines.push("Qualitative");
  lines.push(formatQualitativeLine("rootCause", metrics.qualitative.rootCause));
  lines.push(formatQualitativeLine("evidence", metrics.qualitative.evidence));
  lines.push(formatQualitativeLine("recommendedFix", metrics.qualitative.recommendedFix));
  lines.push(formatQualitativeLine("historyUsage", metrics.qualitative.historyUsage));
  lines.push(formatQualitativeLine("inferenceQuality", metrics.qualitative.inferenceQuality));
  lines.push("");
  lines.push("Evidence grounding");
  lines.push("  Fabricated/unsupported evidence finding:");
  lines.push(`    No: ${metrics.evidenceGrounding.fabricatedEvidence.false}`);
  lines.push(`    Yes: ${metrics.evidenceGrounding.fabricatedEvidence.true}`);
  lines.push("");
  lines.push("Knowledge");
  lines.push(`  Applicable samples: ${metrics.knowledge.applicable}`);
  lines.push(`  Not applicable: ${metrics.knowledge.notApplicable}`);
  lines.push(formatQualitativeLine("selectionCorrect", metrics.knowledge.selectionCorrect));
  lines.push(formatQualitativeLine("usage", metrics.qualitative.knowledgeUsage));
  lines.push(formatQualitativeLine("grounding", metrics.qualitative.knowledgeGrounding));
  lines.push("");
  lines.push("Correlation");
  lines.push(`  Applicable samples: ${metrics.correlation.applicable}`);
  lines.push("");
  lines.push("  Construction:");
  for (const [key, count] of Object.entries(metrics.correlation.construction)) lines.push(`    ${key}: ${count}`);
  lines.push("");
  lines.push("  Transport:");
  for (const [key, count] of Object.entries(metrics.correlation.transport)) lines.push(`    ${key}: ${count}`);
  lines.push("");
  lines.push("  Reasoning:");
  for (const [key, count] of Object.entries(metrics.correlation.reasoning)) lines.push(`    ${key}: ${count}`);

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
    for (const sample of shouldRetryMismatches) lines.push(`  - ${sample.id}`);
  }

  const shouldCreateBugMismatches = samples.filter((s) => !s.shouldCreateBug.correct);
  if (shouldCreateBugMismatches.length > 0) {
    lines.push("");
    lines.push("shouldCreateBug mismatches");
    for (const sample of shouldCreateBugMismatches) lines.push(`  - ${sample.id}`);
  }

  const modelShouldCreateBugMismatches = samples.filter((s) => s.modelShouldCreateBugCorrect === false);
  if (modelShouldCreateBugMismatches.length > 0) {
    lines.push("");
    lines.push("modelShouldCreateBugCorrect mismatches (raw model wrong; final system may still be correct via policy)");
    for (const sample of modelShouldCreateBugMismatches) lines.push(`  - ${sample.id}`);
  }

  const ambiguousSamples = samples.filter((s) => s.isAmbiguous);
  if (ambiguousSamples.length > 0) {
    lines.push("");
    lines.push("Ambiguous classifications");
    for (const sample of ambiguousSamples) {
      lines.push(`  - ${sample.id}: expected ${sample.classification.expected}, actual ${sample.classification.actual}`);
    }
  }

  if ((dataset.historicalObservations || []).length > 0) {
    lines.push("");
    lines.push("Historical observations (not scored - see dataset.historicalObservations)");
    for (const observation of dataset.historicalObservations) {
      lines.push(`  - ${observation.id}: ${observation.summary}`);
    }
  }

  return lines.join("\n");
}

function run(datasetPath, options) {
  const json = Boolean(options && options.json);

  const raw = fs.readFileSync(datasetPath, "utf8");
  const dataset = JSON.parse(raw);

  const validation = validateDatasetV5(dataset);
  if (!validation.valid) {
    const output = ["Dataset v5 failed validation:", ...validation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const evaluation = evaluateDatasetV5(dataset);
  const output = json ? JSON.stringify(evaluation.metrics, null, 2) : formatEvaluationSummaryV5(evaluation, dataset);

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

module.exports = { formatEvaluationSummaryV5, formatPercentage, run };
