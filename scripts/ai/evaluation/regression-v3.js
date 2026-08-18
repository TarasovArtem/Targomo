/**
 * Deterministic, offline regression comparator for Dataset v3 / Baseline v3.
 *
 * Separate from regression.js (v1) and regression-v2.js (v2) - both stay
 * untouched. Structurally identical to regression-v2.js: the same
 * "any regression anywhere wins" per-sample design, across the same seven
 * comparison dimensions (classification, shouldRetry, shouldCreateBug,
 * fabricatedEvidence, correlationConstruction, correlationTransport,
 * correlationReasoning). Dataset v3 introduces no new regression semantics;
 * it exists to protect an additional (7th) sample, not a new comparison
 * rule. A few tiny pure helpers are intentionally duplicated here rather
 * than imported from regression-v2.js, the same "small duplicated
 * primitives, not a shared refactor" trade-off already used throughout this
 * directory.
 *
 * Roadmap #12 closed the previous known limitation: rootCause/evidence/
 * recommendedFix are now individually per-sample regression-protected here
 * too, via the same compareQualityTernary() ordering already used for
 * correlation quality (fail < partial < pass, not_applicable outside that
 * ordering). All ten dimensions - classification/shouldRetry/
 * shouldCreateBug/fabricatedEvidence/rootCause/evidence/recommendedFix/
 * correlationConstruction/correlationTransport/correlationReasoning - follow
 * the same "any regression anywhere wins" precedence: a sample where
 * rootCause silently flips from "pass" to "fail" now flips this
 * comparator's status to REGRESSED by itself, even if every other dimension
 * on every other sample improved.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { validateDatasetV3 } = require("./dataset-v3-schema");
const { validateBaselineV3 } = require("./baseline-v3-schema");
const { evaluateDatasetV3 } = require("./scoring-v3");

const DEFAULT_DATASET_PATH = path.join(__dirname, "dataset-v3.json");
const DEFAULT_BASELINE_PATH = path.join(__dirname, "baseline-v3.json");

const QUALITY_RANK = { fail: 0, partial: 1, pass: 2 };
const CORRELATION_DIMENSIONS = ["correlationConstruction", "correlationTransport", "correlationReasoning"];
// Roadmap #12: rootCause/evidence/recommendedFix use the identical
// fail<partial<pass ordering as the correlation dimensions above, via the
// same compareQualityTernary() comparator - reused as-is, not duplicated.
const QUALITATIVE_DIMENSIONS = ["rootCause", "evidence", "recommendedFix"];

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

// Mirror-image polarity of compareCorrectness, identical to regression.js/
// regression-v2.js: fabricatedEvidence's good state is false, so false ->
// true is the regression, not true -> false.
function compareFabricatedEvidence(baselineValue, currentValue) {
  if (baselineValue === false && currentValue === true) return "regression";
  if (baselineValue === true && currentValue === false) return "improvement";
  return "unchanged";
}

function compareClassification(baselineStatus, currentStatus) {
  // Identical conservative rule to v1/v2: either side "ambiguous" makes the
  // classification dimension informational-only for this sample.
  if (baselineStatus === "ambiguous" || currentStatus === "ambiguous") return "informational";
  if (baselineStatus === "pass" && currentStatus === "pass") return "unchanged";
  if (baselineStatus === "pass" && currentStatus === "fail") return "regression";
  if (baselineStatus === "fail" && currentStatus === "pass") return "improvement";
  return "unchanged";
}

// Shared ordering for all three correlation quality dimensions: fail(0) <
// partial(1) < pass(2). not_applicable sits outside the ordering.
function compareQualityTernary(baselineValue, currentValue) {
  if (baselineValue === "not_applicable" && currentValue === "not_applicable") return "unchanged";
  if (baselineValue === "not_applicable" || currentValue === "not_applicable") return "informational";

  const baselineRank = QUALITY_RANK[baselineValue];
  const currentRank = QUALITY_RANK[currentValue];
  if (currentRank > baselineRank) return "improvement";
  if (currentRank < baselineRank) return "regression";
  return "unchanged";
}

// Pure function: { metrics, samples } (evaluateDatasetV3() output) + an
// already-validated baseline object in, a structured comparison out.
function compareEvaluationToBaselineV3(currentEvaluation, baseline) {
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
    const fabricatedEvidenceChange = compareFabricatedEvidence(baselineSample.fabricatedEvidence, currentSample.quality.fabricatedEvidence);

    const correlationChanges = {};
    for (const dimension of CORRELATION_DIMENSIONS) {
      correlationChanges[dimension] = compareQualityTernary(baselineSample[dimension], currentSample.quality[dimension]);
    }

    // Roadmap #12: rootCause/evidence/recommendedFix, per sample.
    const qualitativeChanges = {};
    for (const dimension of QUALITATIVE_DIMENSIONS) {
      qualitativeChanges[dimension] = compareQualityTernary(baselineSample[dimension], currentSample.quality[dimension]);
    }

    for (const change of [
      classificationChange,
      shouldRetryChange,
      shouldCreateBugChange,
      fabricatedEvidenceChange,
      ...Object.values(correlationChanges),
      ...Object.values(qualitativeChanges),
    ]) {
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
      fabricatedEvidence: {
        baseline: baselineSample.fabricatedEvidence,
        current: currentSample.quality.fabricatedEvidence,
        change: fabricatedEvidenceChange,
      },
      rootCause: {
        baseline: baselineSample.rootCause,
        current: currentSample.quality.rootCause,
        change: qualitativeChanges.rootCause,
      },
      evidence: {
        baseline: baselineSample.evidence,
        current: currentSample.quality.evidence,
        change: qualitativeChanges.evidence,
      },
      recommendedFix: {
        baseline: baselineSample.recommendedFix,
        current: currentSample.quality.recommendedFix,
        change: qualitativeChanges.recommendedFix,
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

  // Precedence identical to v1/v2: any single regression anywhere - across
  // any of the seven dimensions, on any sample - outweighs any number of
  // simultaneous improvements.
  const status = regressions > 0 ? "REGRESSED" : improvements > 0 ? "IMPROVED" : "UNCHANGED";

  return {
    status,
    summary: { improvements, regressions, unchanged, informational },
    samples,
  };
}

function formatRegressionReportV3(comparison) {
  const lines = ["QA Agent Regression Check — Baseline v3", ""];

  if (comparison.status === "BASELINE_MISMATCH") {
    lines.push("Status: BASELINE_MISMATCH", "", "Errors:");
    for (const error of comparison.errors) lines.push(`  - ${error}`);
    return lines.join("\n");
  }

  lines.push(`Status: ${comparison.status}`, "", "Improvements:", `  ${comparison.summary.improvements}`, "", "Regressions:", `  ${comparison.summary.regressions}`);

  const allDimensions = [
    "classification",
    "shouldRetry",
    "shouldCreateBug",
    "fabricatedEvidence",
    "rootCause",
    "evidence",
    "recommendedFix",
    "correlationConstruction",
    "correlationTransport",
    "correlationReasoning",
  ];
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
    if (sample.fabricatedEvidence.change === "unchanged" && sample.fabricatedEvidence.baseline === true) {
      knownDeficiencies.push(`${sample.id} fabricatedEvidence`);
    }
    // Roadmap #12: same "unchanged and already at the worst state" known-
    // deficiency convention as classification (baseline === "fail").
    if (sample.rootCause.change === "unchanged" && sample.rootCause.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} rootCause`);
    }
    if (sample.evidence.change === "unchanged" && sample.evidence.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} evidence`);
    }
    if (sample.recommendedFix.change === "unchanged" && sample.recommendedFix.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} recommendedFix`);
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
  const datasetValidation = validateDatasetV3(dataset);
  if (!datasetValidation.valid) {
    const output = ["Dataset v3 failed validation:", ...datasetValidation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const baselineValidation = validateBaselineV3(baseline);
  if (!baselineValidation.valid) {
    const output = ["Baseline v3 failed validation:", ...baselineValidation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const currentEvaluation = evaluateDatasetV3(dataset);
  const comparison = compareEvaluationToBaselineV3(currentEvaluation, baseline);

  if (comparison.status === "BASELINE_MISMATCH") {
    return { exitCode: 1, output: formatRegressionReportV3(comparison) };
  }

  // Informational only, same as v1/v2: even REGRESSED exits 0 here.
  return { exitCode: 0, output: formatRegressionReportV3(comparison) };
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

module.exports = { compareEvaluationToBaselineV3, formatRegressionReportV3, run };
