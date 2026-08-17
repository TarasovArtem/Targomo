/**
 * Deterministic, offline scoring for the QA Agent evaluation Dataset v3
 * (scripts/ai/evaluation/dataset-v3.json).
 *
 * Structurally identical to scoring-v2.js (Dataset v2) - same classification/
 * shouldRetry/shouldCreateBug semantics, same qualitative aggregates, same
 * evidenceGrounding boolean count, same correlation quality aggregates.
 * Dataset v3 introduces no new scoring dimension; it exists to score an
 * additional (7th) sample, not a new sample shape. Kept as its own module
 * (rather than parameterizing scoring-v2.js) for the same reason v1/v2 stay
 * separate: Dataset v2 and Baseline v2 must never be put at risk by a v3
 * change, and vice versa.
 *
 * Scores four things separately, on purpose - never combined into a
 * composite score, for the same reason scoring.js/scoring-v2.js never do:
 *   - classification accuracy
 *   - action accuracy (shouldRetry / final shouldCreateBug)
 *   - qualitative aggregates (rootCause/evidence/recommendedFix/historyUsage)
 *   - evidence-grounding aggregate (fabricatedEvidence, boolean count)
 *   - correlation quality aggregates (construction/transport/reasoning)
 */

"use strict";

const QUALITY_TERNARY_VALUES = ["pass", "partial", "fail", "not_applicable"];
const QUALITY_HISTORY_USAGE_VALUES = ["appropriate", "neutral", "misleading", "not_clear"];

function zeroCounts(values) {
  const counts = {};
  for (const value of values) counts[value] = 0;
  return counts;
}

// Same boolean-count treatment as scoring.js/scoring-v2.js - fabricatedEvidence
// is not one of the ternary quality enums, so it is never forced into
// QUALITY_TERNARY_VALUES or the qualitative/correlation aggregates.
function countFabricatedEvidence(samples) {
  const counts = { false: 0, true: 0 };
  for (const sample of samples) {
    counts[String(sample.quality.fabricatedEvidence)] += 1;
  }
  return counts;
}

function ratio(correct, total) {
  return total === 0 ? null : correct / total;
}

function scoreSampleV3(sample) {
  const isAmbiguous = sample.ambiguity.isAmbiguous === true;

  const classification = isAmbiguous
    ? {
        status: "ambiguous",
        expected: sample.groundTruth.classification,
        actual: sample.actual.classification,
      }
    : {
        status: sample.actual.classification === sample.groundTruth.classification ? "correct" : "incorrect",
        expected: sample.groundTruth.classification,
        actual: sample.actual.classification,
      };

  const shouldRetry = {
    correct: sample.actual.shouldRetry === sample.groundTruth.shouldRetry,
    expected: sample.groundTruth.shouldRetry,
    actual: sample.actual.shouldRetry,
  };

  // Scored against finalShouldCreateBug, never originalShouldCreateBug -
  // identical rule to scoring.js/scoring-v2.js.
  const shouldCreateBug = {
    correct: sample.actual.finalShouldCreateBug === sample.groundTruth.shouldCreateBug,
    expected: sample.groundTruth.shouldCreateBug,
    actual: sample.actual.finalShouldCreateBug,
  };

  return {
    id: sample.id,
    isAmbiguous,
    classification,
    shouldRetry,
    shouldCreateBug,
    policyAdjusted: sample.actual.policyAdjusted === true,
    quality: sample.quality,
    correlationApplicable: sample.correlation.applicable === true,
  };
}

// Pure function: dataset in, { metrics, samples } out. Assumes the caller
// has already run validateDatasetV3() and confirmed dataset.valid.
function evaluateDatasetV3(dataset) {
  const samples = dataset.samples.map(scoreSampleV3);

  const totalSamples = samples.length;
  const classificationAmbiguous = samples.filter((s) => s.isAmbiguous).length;
  const classificationScorable = totalSamples - classificationAmbiguous;

  const scorableClassifications = samples.filter((s) => !s.isAmbiguous);
  const classificationCorrect = scorableClassifications.filter((s) => s.classification.status === "correct").length;
  const classificationIncorrect = scorableClassifications.filter((s) => s.classification.status === "incorrect").length;

  const shouldRetryCorrect = samples.filter((s) => s.shouldRetry.correct).length;
  const shouldRetryIncorrect = totalSamples - shouldRetryCorrect;

  const shouldCreateBugCorrect = samples.filter((s) => s.shouldCreateBug.correct).length;
  const shouldCreateBugIncorrect = totalSamples - shouldCreateBugCorrect;

  const policyInterventions = samples.filter((s) => s.policyAdjusted).length;

  const rootCause = zeroCounts(QUALITY_TERNARY_VALUES);
  const evidence = zeroCounts(QUALITY_TERNARY_VALUES);
  const recommendedFix = zeroCounts(QUALITY_TERNARY_VALUES);
  const historyUsage = zeroCounts(QUALITY_HISTORY_USAGE_VALUES);

  const correlationConstruction = zeroCounts(QUALITY_TERNARY_VALUES);
  const correlationTransport = zeroCounts(QUALITY_TERNARY_VALUES);
  const correlationReasoning = zeroCounts(QUALITY_TERNARY_VALUES);

  let correlationApplicable = 0;

  for (const sample of samples) {
    rootCause[sample.quality.rootCause] += 1;
    evidence[sample.quality.evidence] += 1;
    recommendedFix[sample.quality.recommendedFix] += 1;
    historyUsage[sample.quality.historyUsage] += 1;

    correlationConstruction[sample.quality.correlationConstruction] += 1;
    correlationTransport[sample.quality.correlationTransport] += 1;
    correlationReasoning[sample.quality.correlationReasoning] += 1;

    if (sample.correlationApplicable) correlationApplicable += 1;
  }

  const metrics = {
    totalSamples,
    classificationScorable,
    classificationAmbiguous,
    classificationCorrect,
    classificationIncorrect,
    classificationAccuracy: ratio(classificationCorrect, classificationScorable),
    shouldRetryCorrect,
    shouldRetryIncorrect,
    shouldRetryAccuracy: ratio(shouldRetryCorrect, totalSamples),
    shouldCreateBugCorrect,
    shouldCreateBugIncorrect,
    shouldCreateBugAccuracy: ratio(shouldCreateBugCorrect, totalSamples),
    policyInterventions,
    qualitative: { rootCause, evidence, recommendedFix, historyUsage },
    evidenceGrounding: { fabricatedEvidence: countFabricatedEvidence(samples) },
    correlation: {
      applicable: correlationApplicable,
      notApplicable: totalSamples - correlationApplicable,
      construction: correlationConstruction,
      transport: correlationTransport,
      reasoning: correlationReasoning,
    },
  };

  return { metrics, samples };
}

module.exports = { evaluateDatasetV3 };
