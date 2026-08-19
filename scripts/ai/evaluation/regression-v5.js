/**
 * Deterministic, offline regression comparator for Dataset v5 / Baseline v5.
 *
 * Separate from regression.js (v1), regression-v2.js (v2), regression-v3.js
 * (v3), and regression-v4.js (v4) - all four stay untouched. Derived from
 * regression-v4.js's ten comparison dimensions (classification, shouldRetry,
 * shouldCreateBug, fabricatedEvidence, rootCause, evidence, recommendedFix,
 * correlationConstruction, correlationTransport, correlationReasoning) plus
 * five new ones added by Roadmap #16E.1, each justified by a concrete
 * failure mode observed in the K1-K5 controlled knowledge-validation
 * experiments (Roadmap #16D):
 *
 *   - modelShouldCreateBugCorrect: protects against the model's RAW
 *     shouldCreateBug decision silently degrading while
 *     agent-policy.js's deterministic post-model gate keeps masking it in
 *     the (already-protected) shouldCreateBug/finalShouldCreateBug
 *     dimension. K3 is the concrete case: model wrong
 *     (originalShouldCreateBug=true for a TEST_BUG), policy correct
 *     (finalShouldCreateBug=false) - a regression harness watching only
 *     the final dimension would never see this model degrade.
 *
 *   - knowledgeSelectionCorrect: protects against the deterministic
 *     selector regressing to over- or under-selection (the exact defect
 *     K2 exposed and PR #54 fixed) - v1-v4 have no dimension that could
 *     ever catch this, since they predate knowledge selection entirely.
 *
 *   - knowledgeUsage: protects against selected-but-irrelevant/subordinate
 *     knowledge corrupting a diagnosis it would otherwise get right (the
 *     central risk K3/K4 were designed to test).
 *
 *   - knowledgeGrounding: protects against a knowledge statement being
 *     laundered into `evidence` as an observed current-run fact.
 *
 *   - inferenceQuality: protects against a REAL-SOURCE-BUT-INVALID
 *     inference (K1's backward "0 recent failures... has not been
 *     passing"; K3's overreaching "...and not a product regression") -
 *     fabricatedEvidence alone cannot detect this, since no unobserved
 *     technical mechanism was invented in either case.
 *
 * All comparisons keep the identical "any regression anywhere wins"
 * per-sample design as v1-v4. A few tiny pure helpers are intentionally
 * duplicated here rather than imported from regression-v4.js, the same
 * "small duplicated primitives, not a shared refactor" trade-off already
 * used throughout this directory.
 *
 * modelShouldCreateBugCorrect and inferenceQuality both admit `null`
 * ("not evaluated" - see baseline-v5-schema.js). A transition into or out
 * of `null` is always "informational", NEVER silently treated as a
 * regression, an improvement, or as equivalent to "not_applicable" - see
 * compareModelShouldCreateBugCorrect() and compareQualityTernaryOrNull()
 * below, and regression-v5.test.js's dedicated null-handling tests.
 *
 * Provenance fields (revalidationOfExperiment/providerAttempts/
 * firstAttemptError/originalShouldCreateBug itself/policyAdjusted) are
 * deliberately never compared or tallied into regressions/improvements -
 * identical rule to regression-v4.js.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { validateDatasetV5 } = require("./dataset-v5-schema");
const { validateBaselineV5 } = require("./baseline-v5-schema");
const { evaluateDatasetV5 } = require("./scoring-v5");

const DEFAULT_DATASET_PATH = path.join(__dirname, "dataset-v5.json");
const DEFAULT_BASELINE_PATH = path.join(__dirname, "baseline-v5.json");

const QUALITY_RANK = { fail: 0, partial: 1, pass: 2 };
const CORRELATION_DIMENSIONS = ["correlationConstruction", "correlationTransport", "correlationReasoning"];
const QUALITATIVE_DIMENSIONS = ["rootCause", "evidence", "recommendedFix"];
// New in v5. knowledgeSelectionCorrect never actually produces "partial" in
// practice (scoreKnowledgeSelection() is inherently pass/fail/not_applicable),
// but reuses the identical ternary+not_applicable ordering/comparator as
// the dimensions above rather than inventing a parallel boolean-only path.
const KNOWLEDGE_TERNARY_DIMENSIONS = ["knowledgeSelectionCorrect", "knowledgeUsage", "knowledgeGrounding"];

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

function compareFabricatedEvidence(baselineValue, currentValue) {
  if (baselineValue === false && currentValue === true) return "regression";
  if (baselineValue === true && currentValue === false) return "improvement";
  return "unchanged";
}

function compareClassification(baselineStatus, currentStatus) {
  if (baselineStatus === "ambiguous" || currentStatus === "ambiguous") return "informational";
  if (baselineStatus === "pass" && currentStatus === "pass") return "unchanged";
  if (baselineStatus === "pass" && currentStatus === "fail") return "regression";
  if (baselineStatus === "fail" && currentStatus === "pass") return "improvement";
  return "unchanged";
}

// Shared ordering for all ternary quality dimensions (correlation*,
// rootCause/evidence/recommendedFix, and the new knowledgeSelectionCorrect/
// knowledgeUsage/knowledgeGrounding): fail(0) < partial(1) < pass(2).
// not_applicable sits outside the ordering - never better or worse than
// pass/partial/fail, only ever "informational" against them.
function compareQualityTernary(baselineValue, currentValue) {
  if (baselineValue === "not_applicable" && currentValue === "not_applicable") return "unchanged";
  if (baselineValue === "not_applicable" || currentValue === "not_applicable") return "informational";

  const baselineRank = QUALITY_RANK[baselineValue];
  const currentRank = QUALITY_RANK[currentValue];
  if (currentRank > baselineRank) return "improvement";
  if (currentRank < baselineRank) return "regression";
  return "unchanged";
}

// New in v5, for inferenceQuality only: identical to compareQualityTernary
// for the four normal values, but treats `null` ("not evaluated") as a
// THIRD outside-ordering state, distinct from "not_applicable" - per
// Roadmap #16D's explicit instruction not to invent ordering between
// not_applicable/not_evaluated/pass. Curating a previously-null sample for
// the first time is "informational" (a curation event), never scored as an
// improvement; a curated value silently reverting to null would likewise
// be "informational", never a regression - the loss of a judgment is a
// process/provenance fact, not a quality change, in the same spirit as
// providerAttempts/policyAdjusted staying out of the tally entirely.
function compareQualityTernaryOrNull(baselineValue, currentValue) {
  if (baselineValue === null && currentValue === null) return "unchanged";
  if (baselineValue === null || currentValue === null) return "informational";
  return compareQualityTernary(baselineValue, currentValue);
}

// New in v5, for modelShouldCreateBugCorrect only: boolean-or-null mirror of
// compareCorrectness()/compareQualityTernaryOrNull() - null is a genuine
// "not evaluated" state (e.g. a hypothetical future inherited sample
// lacking originalShouldCreateBug), never coerced into true/false.
function compareModelShouldCreateBugCorrect(baselineValue, currentValue) {
  if (baselineValue === null && currentValue === null) return "unchanged";
  if (baselineValue === null || currentValue === null) return "informational";
  return compareCorrectness(baselineValue, currentValue);
}

function compareEvaluationToBaselineV5(currentEvaluation, baseline) {
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
    const modelShouldCreateBugChange = compareModelShouldCreateBugCorrect(baselineSample.modelShouldCreateBugCorrect, currentSample.modelShouldCreateBugCorrect);
    const fabricatedEvidenceChange = compareFabricatedEvidence(baselineSample.fabricatedEvidence, currentSample.quality.fabricatedEvidence);

    const correlationChanges = {};
    for (const dimension of CORRELATION_DIMENSIONS) {
      correlationChanges[dimension] = compareQualityTernary(baselineSample[dimension], currentSample.quality[dimension]);
    }

    const qualitativeChanges = {};
    for (const dimension of QUALITATIVE_DIMENSIONS) {
      qualitativeChanges[dimension] = compareQualityTernary(baselineSample[dimension], currentSample.quality[dimension]);
    }

    // New in v5. knowledgeSelectionCorrect lives on the scored sample
    // itself (currentSample.knowledgeSelectionCorrect), not under
    // currentSample.quality, since it is derived (see scoring-v5.js), not
    // curated - knowledgeUsage/knowledgeGrounding remain under .quality
    // exactly like rootCause/evidence/recommendedFix.
    const knowledgeChanges = {
      knowledgeSelectionCorrect: compareQualityTernary(baselineSample.knowledgeSelectionCorrect, currentSample.knowledgeSelectionCorrect),
      knowledgeUsage: compareQualityTernary(baselineSample.knowledgeUsage, currentSample.quality.knowledgeUsage),
      knowledgeGrounding: compareQualityTernary(baselineSample.knowledgeGrounding, currentSample.quality.knowledgeGrounding),
    };

    const inferenceQualityChange = compareQualityTernaryOrNull(baselineSample.inferenceQuality, currentSample.quality.inferenceQuality);

    for (const change of [
      classificationChange,
      shouldRetryChange,
      shouldCreateBugChange,
      modelShouldCreateBugChange,
      fabricatedEvidenceChange,
      ...Object.values(correlationChanges),
      ...Object.values(qualitativeChanges),
      ...Object.values(knowledgeChanges),
      inferenceQualityChange,
    ]) {
      tally(change);
    }

    samples.push({
      id: currentSample.id,
      classification: { baseline: baselineClassificationStatus, current: currentClassificationStatus, change: classificationChange },
      shouldRetry: { baselineCorrect: baselineSample.shouldRetryCorrect, currentCorrect: currentSample.shouldRetry.correct, change: shouldRetryChange },
      shouldCreateBug: { baselineCorrect: baselineSample.shouldCreateBugCorrect, currentCorrect: currentSample.shouldCreateBug.correct, change: shouldCreateBugChange },
      modelShouldCreateBugCorrect: {
        baseline: baselineSample.modelShouldCreateBugCorrect,
        current: currentSample.modelShouldCreateBugCorrect,
        change: modelShouldCreateBugChange,
      },
      fabricatedEvidence: { baseline: baselineSample.fabricatedEvidence, current: currentSample.quality.fabricatedEvidence, change: fabricatedEvidenceChange },
      rootCause: { baseline: baselineSample.rootCause, current: currentSample.quality.rootCause, change: qualitativeChanges.rootCause },
      evidence: { baseline: baselineSample.evidence, current: currentSample.quality.evidence, change: qualitativeChanges.evidence },
      recommendedFix: { baseline: baselineSample.recommendedFix, current: currentSample.quality.recommendedFix, change: qualitativeChanges.recommendedFix },
      correlationConstruction: { baseline: baselineSample.correlationConstruction, current: currentSample.quality.correlationConstruction, change: correlationChanges.correlationConstruction },
      correlationTransport: { baseline: baselineSample.correlationTransport, current: currentSample.quality.correlationTransport, change: correlationChanges.correlationTransport },
      correlationReasoning: { baseline: baselineSample.correlationReasoning, current: currentSample.quality.correlationReasoning, change: correlationChanges.correlationReasoning },
      knowledgeSelectionCorrect: { baseline: baselineSample.knowledgeSelectionCorrect, current: currentSample.knowledgeSelectionCorrect, change: knowledgeChanges.knowledgeSelectionCorrect },
      knowledgeUsage: { baseline: baselineSample.knowledgeUsage, current: currentSample.quality.knowledgeUsage, change: knowledgeChanges.knowledgeUsage },
      knowledgeGrounding: { baseline: baselineSample.knowledgeGrounding, current: currentSample.quality.knowledgeGrounding, change: knowledgeChanges.knowledgeGrounding },
      inferenceQuality: { baseline: baselineSample.inferenceQuality, current: currentSample.quality.inferenceQuality, change: inferenceQualityChange },
    });
  }

  // Precedence identical to v1-v4: any single regression anywhere - across
  // any of the fifteen comparison dimensions, on any sample - outweighs any
  // number of simultaneous improvements.
  const status = regressions > 0 ? "REGRESSED" : improvements > 0 ? "IMPROVED" : "UNCHANGED";

  return {
    status,
    summary: { improvements, regressions, unchanged, informational },
    samples,
  };
}

function formatRegressionReportV5(comparison) {
  const lines = ["QA Agent Regression Check — Baseline v5", ""];

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
    "modelShouldCreateBugCorrect",
    "fabricatedEvidence",
    "rootCause",
    "evidence",
    "recommendedFix",
    "correlationConstruction",
    "correlationTransport",
    "correlationReasoning",
    "knowledgeSelectionCorrect",
    "knowledgeUsage",
    "knowledgeGrounding",
    "inferenceQuality",
  ];
  const regressionDetails = [];
  const improvementDetails = [];
  const knownDeficiencies = [];
  const ambiguousIds = [];
  const correlationBaseline = [];
  const knowledgeBaseline = [];

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
    if (sample.modelShouldCreateBugCorrect.change === "unchanged" && sample.modelShouldCreateBugCorrect.baseline === false) {
      knownDeficiencies.push(`${sample.id} modelShouldCreateBugCorrect`);
    }
    if (sample.fabricatedEvidence.change === "unchanged" && sample.fabricatedEvidence.baseline === true) {
      knownDeficiencies.push(`${sample.id} fabricatedEvidence`);
    }
    if (sample.rootCause.change === "unchanged" && sample.rootCause.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} rootCause`);
    }
    if (sample.evidence.change === "unchanged" && sample.evidence.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} evidence`);
    }
    if (sample.recommendedFix.change === "unchanged" && sample.recommendedFix.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} recommendedFix`);
    }
    if (sample.knowledgeSelectionCorrect.change === "unchanged" && sample.knowledgeSelectionCorrect.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} knowledgeSelectionCorrect`);
    }
    if (sample.knowledgeUsage.change === "unchanged" && sample.knowledgeUsage.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} knowledgeUsage`);
    }
    if (sample.knowledgeGrounding.change === "unchanged" && sample.knowledgeGrounding.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} knowledgeGrounding`);
    }
    if (sample.inferenceQuality.change === "unchanged" && sample.inferenceQuality.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} inferenceQuality`);
    }
    if (sample.classification.baseline === "ambiguous" || sample.classification.current === "ambiguous") {
      ambiguousIds.push(sample.id);
    }
    if (sample.correlationConstruction.current !== "not_applicable") {
      correlationBaseline.push(`${sample.id}: construction=${sample.correlationConstruction.current}, transport=${sample.correlationTransport.current}, reasoning=${sample.correlationReasoning.current}`);
    }
    if (sample.knowledgeSelectionCorrect.current !== "not_applicable") {
      knowledgeBaseline.push(`${sample.id}: selection=${sample.knowledgeSelectionCorrect.current}, usage=${sample.knowledgeUsage.current}, grounding=${sample.knowledgeGrounding.current}`);
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
  if (knowledgeBaseline.length > 0) {
    lines.push("", "Knowledge baseline:");
    for (const line of knowledgeBaseline) lines.push(`  - ${line}`);
  }

  return lines.join("\n");
}

function run(datasetPath, baselinePath) {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const datasetValidation = validateDatasetV5(dataset);
  if (!datasetValidation.valid) {
    const output = ["Dataset v5 failed validation:", ...datasetValidation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const baselineValidation = validateBaselineV5(baseline);
  if (!baselineValidation.valid) {
    const output = ["Baseline v5 failed validation:", ...baselineValidation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const currentEvaluation = evaluateDatasetV5(dataset);
  const comparison = compareEvaluationToBaselineV5(currentEvaluation, baseline);

  if (comparison.status === "BASELINE_MISMATCH") {
    return { exitCode: 1, output: formatRegressionReportV5(comparison) };
  }

  return { exitCode: 0, output: formatRegressionReportV5(comparison) };
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

module.exports = {
  compareEvaluationToBaselineV5,
  formatRegressionReportV5,
  run,
  compareQualityTernary,
  compareQualityTernaryOrNull,
  compareModelShouldCreateBugCorrect,
  compareCorrectness,
  compareFabricatedEvidence,
};
