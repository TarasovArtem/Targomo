/**
 * Deterministic, offline regression comparator for Dataset v2 / Baseline v2.
 *
 * Separate from regression.js (Dataset v1) - v1 stays untouched. A few tiny
 * pure helpers (toBaselineClassificationStatus/compareCorrectness/
 * compareClassification) are intentionally duplicated here rather than
 * imported from regression.js, since v1's module doesn't export them as a
 * public API and must not be modified to expose them - same "small
 * duplicated primitives, not a shared refactor" trade-off already used by
 * baseline-schema.js/dataset-v2-schema.js elsewhere in this directory.
 *
 * Extends v1's per-sample "any regression wins" design (see regression.js's
 * own module comment) with three new comparison dimensions -
 * correlationConstruction/correlationTransport/correlationReasoning - using
 * one shared ordering: fail < partial < pass, with not_applicable outside
 * that ordering entirely (an applicability change is reported as
 * "informational", never silently scored as a quality regression or
 * improvement).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { validateDatasetV2 } = require("./dataset-v2-schema");
const { validateBaselineV2 } = require("./baseline-v2-schema");
const { evaluateDatasetV2 } = require("./scoring-v2");

const DEFAULT_DATASET_PATH = path.join(__dirname, "dataset-v2.json");
const DEFAULT_BASELINE_PATH = path.join(__dirname, "baseline-v2.json");

const QUALITY_RANK = { fail: 0, partial: 1, pass: 2 };
const CORRELATION_DIMENSIONS = ["correlationConstruction", "correlationTransport", "correlationReasoning"];

function toBaselineClassificationStatus(scoringStatus) {
  if (scoringStatus === "correct") return "pass";
  if (scoringStatus === "incorrect") return "fail";
  return "ambiguous";
}

function compareCorrectness(baselineCorrect, currentCorrect) {
  if (baselineCorrect === true && currentCorrect === false) return "regression";
  if (baselineCorrect === false && currentCorrect === true) return "improvement";
  return "unchanged";
}

function compareClassification(baselineStatus, currentStatus) {
  // Identical conservative rule to v1: either side "ambiguous" makes the
  // classification dimension informational-only for this sample.
  if (baselineStatus === "ambiguous" || currentStatus === "ambiguous") return "informational";
  if (baselineStatus === "pass" && currentStatus === "pass") return "unchanged";
  if (baselineStatus === "pass" && currentStatus === "fail") return "regression";
  if (baselineStatus === "fail" && currentStatus === "pass") return "improvement";
  return "unchanged";
}

// Shared ordering for all three correlation quality dimensions: fail(0) <
// partial(1) < pass(2). not_applicable sits outside the ordering - both
// sides not_applicable is "unchanged" (correlation stayed inapplicable for
// this sample, as expected for the four migrated v1 samples); either side
// (but not both) being not_applicable is "informational", since a sample's
// correlation applicability is a structural/dataset-identity fact, not a
// quality judgment that should silently register as an improvement or
// regression.
function compareQualityTernary(baselineValue, currentValue) {
  if (baselineValue === "not_applicable" && currentValue === "not_applicable") return "unchanged";
  if (baselineValue === "not_applicable" || currentValue === "not_applicable") return "informational";

  const baselineRank = QUALITY_RANK[baselineValue];
  const currentRank = QUALITY_RANK[currentValue];
  if (currentRank > baselineRank) return "improvement";
  if (currentRank < baselineRank) return "regression";
  return "unchanged";
}

// Pure function: { metrics, samples } (evaluateDatasetV2() output) + an
// already-validated baseline object in, a structured comparison out.
function compareEvaluationToBaselineV2(currentEvaluation, baseline) {
  const baselineIds = Object.keys(baseline.samples).sort();
  const currentIds = currentEvaluation.samples.map((s) => s.id).sort();
  const sameSampleSet = baselineIds.length === currentIds.length && baselineIds.every((id, index) => id === currentIds[index]);

  if (!sameSampleSet) {
    const missingFromCurrent = baselineIds.filter((id) => !currentIds.includes(id));
    const missingFromBaseline = currentIds.filter((id) => !baselineIds.includes(id));
    return {
      status: "BASELINE_MISMATCH",
      errors: [
        ...missingFromCurrent.map((id) => `sample "${id}" is in the baseline but missing from the current evaluation`),
        ...missingFromBaseline.map((id) => `sample "${id}" is in the current evaluation but missing from the baseline`),
      ],
      summary: null,
      samples: [],
    };
  }

  const samples = [];
  let regressions = 0;
  let improvements = 0;
  let unchanged = 0;
  let informational = 0;

  const tally = (change) => {
    if (change === "regression") regressions += 1;
    else if (change === "improvement") improvements += 1;
    else if (change === "informational") informational += 1;
    else unchanged += 1;
  };

  for (const currentSample of currentEvaluation.samples) {
    const baselineSample = baseline.samples[currentSample.id];
    const currentClassificationStatus = toBaselineClassificationStatus(currentSample.classification.status);
    const baselineClassificationStatus = baselineSample.classificationStatus;

    const classificationChange = compareClassification(baselineClassificationStatus, currentClassificationStatus);
    const shouldRetryChange = compareCorrectness(baselineSample.shouldRetryCorrect, currentSample.shouldRetry.correct);
    const shouldCreateBugChange = compareCorrectness(baselineSample.shouldCreateBugCorrect, currentSample.shouldCreateBug.correct);

    const correlationChanges = {};
    for (const dimension of CORRELATION_DIMENSIONS) {
      correlationChanges[dimension] = compareQualityTernary(baselineSample[dimension], currentSample.quality[dimension]);
    }

    for (const change of [classificationChange, shouldRetryChange, shouldCreateBugChange, ...Object.values(correlationChanges)]) {
      tally(change);
    }

    samples.push({
      id: currentSample.id,
      classification: {
        baseline: baselineClassificationStatus,
        current: currentClassificationStatus,
        change: classificationChange,
      },
      shouldRetry: {
        baselineCorrect: baselineSample.shouldRetryCorrect,
        currentCorrect: currentSample.shouldRetry.correct,
        change: shouldRetryChange,
      },
      shouldCreateBug: {
        baselineCorrect: baselineSample.shouldCreateBugCorrect,
        currentCorrect: currentSample.shouldCreateBug.correct,
        change: shouldCreateBugChange,
      },
      correlationConstruction: {
        baseline: baselineSample.correlationConstruction,
        current: currentSample.quality.correlationConstruction,
        change: correlationChanges.correlationConstruction,
      },
      correlationTransport: {
        baseline: baselineSample.correlationTransport,
        current: currentSample.quality.correlationTransport,
        change: correlationChanges.correlationTransport,
      },
      correlationReasoning: {
        baseline: baselineSample.correlationReasoning,
        current: currentSample.quality.correlationReasoning,
        change: correlationChanges.correlationReasoning,
      },
    });
  }

  // Precedence identical to v1: any single regression anywhere - across any
  // of the six dimensions, on any sample - outweighs any number of
  // simultaneous improvements.
  const status = regressions > 0 ? "REGRESSED" : improvements > 0 ? "IMPROVED" : "UNCHANGED";

  return {
    status,
    summary: { improvements, regressions, unchanged, informational },
    samples,
  };
}

function formatRegressionReportV2(comparison) {
  const lines = ["QA Agent Regression Check — Baseline v2", ""];

  if (comparison.status === "BASELINE_MISMATCH") {
    lines.push("Status: BASELINE_MISMATCH", "", "Errors:");
    for (const error of comparison.errors) lines.push(`  - ${error}`);
    return lines.join("\n");
  }

  lines.push(`Status: ${comparison.status}`, "", "Improvements:", `  ${comparison.summary.improvements}`, "", "Regressions:", `  ${comparison.summary.regressions}`);

  const allDimensions = ["classification", "shouldRetry", "shouldCreateBug", "correlationConstruction", "correlationTransport", "correlationReasoning"];
  const regressionDetails = [];
  const improvementDetails = [];
  const knownDeficiencies = [];
  const ambiguousIds = [];
  const correlationBaseline = [];

  for (const sample of comparison.samples) {
    for (const dimension of allDimensions) {
      const change = sample[dimension].change;
      if (change === "regression") regressionDetails.push(`${sample.id} ${dimension}`);
      if (change === "improvement") improvementDetails.push(`${sample.id} ${dimension}`);
    }
    if (sample.classification.change === "unchanged" && sample.classification.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} classification`);
    }
    if (sample.shouldRetry.change === "unchanged" && sample.shouldRetry.baselineCorrect === false) {
      knownDeficiencies.push(`${sample.id} shouldRetry`);
    }
    if (sample.shouldCreateBug.change === "unchanged" && sample.shouldCreateBug.baselineCorrect === false) {
      knownDeficiencies.push(`${sample.id} shouldCreateBug`);
    }
    if (sample.classification.baseline === "ambiguous" || sample.classification.current === "ambiguous") {
      ambiguousIds.push(sample.id);
    }
    if (sample.correlationConstruction.current !== "not_applicable") {
      correlationBaseline.push(`${sample.id}: construction=${sample.correlationConstruction.current}, transport=${sample.correlationTransport.current}, reasoning=${sample.correlationReasoning.current}`);
    }
  }

  if (regressionDetails.length > 0) {
    lines.push("", "Regression details:");
    for (const detail of regressionDetails) lines.push(`  - ${detail}`);
  }
  if (improvementDetails.length > 0) {
    lines.push("", "Improvement details:");
    for (const detail of improvementDetails) lines.push(`  - ${detail}`);
  }
  if (knownDeficiencies.length > 0) {
    lines.push("", "Known deficiencies:");
    for (const deficiency of knownDeficiencies) lines.push(`  - ${deficiency}`);
  }
  if (ambiguousIds.length > 0) {
    lines.push("", "Ambiguous:");
    for (const id of ambiguousIds) lines.push(`  - ${id}`);
  }
  if (correlationBaseline.length > 0) {
    lines.push("", "Correlation baseline:");
    for (const line of correlationBaseline) lines.push(`  - ${line}`);
  }

  return lines.join("\n");
}

function run(datasetPath, baselinePath) {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const datasetValidation = validateDatasetV2(dataset);
  if (!datasetValidation.valid) {
    const output = ["Dataset v2 failed validation:", ...datasetValidation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const baselineValidation = validateBaselineV2(baseline);
  if (!baselineValidation.valid) {
    const output = ["Baseline v2 failed validation:", ...baselineValidation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const currentEvaluation = evaluateDatasetV2(dataset);
  const comparison = compareEvaluationToBaselineV2(currentEvaluation, baseline);

  if (comparison.status === "BASELINE_MISMATCH") {
    return { exitCode: 1, output: formatRegressionReportV2(comparison) };
  }

  // Informational only, same as v1: even REGRESSED exits 0 here.
  return { exitCode: 0, output: formatRegressionReportV2(comparison) };
}

function main() {
  const result = run(DEFAULT_DATASET_PATH, DEFAULT_BASELINE_PATH);
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

module.exports = { compareEvaluationToBaselineV2, formatRegressionReportV2, run };
