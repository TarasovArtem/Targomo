/**
 * Deterministic, offline scoring for the QA Agent evaluation Dataset v2
 * (scripts/ai/evaluation/dataset-v2.json).
 *
 * Separate from scoring.js (Dataset v1) by design - Dataset v1 stays frozen
 * and its own scorer untouched. This module deliberately mirrors v1's
 * classification/shouldRetry/shouldCreateBug semantics exactly (same
 * ambiguity-exclusion rule, same finalShouldCreateBug-based action scoring)
 * rather than forking them, and adds one new, independently-reported
 * dimension: correlation quality (construction/transport/reasoning).
 *
 * Scores four things separately, on purpose - never combined into a
 * composite score, for the same reason scoring.js never does:
 *   - classification accuracy
 *   - action accuracy (shouldRetry / final shouldCreateBug)
 *   - qualitative aggregates (rootCause/evidence/recommendedFix/historyUsage)
 *   - correlation quality aggregates (construction/transport/reasoning) -
 *     reported as enum counts, never as a numeric/weighted score (no
 *     pass=1/partial=0.5/fail=0) - with only two applicable samples today,
 *     any such number would imply false precision and would hide exactly
 *     which correlation dimension needs attention, the same failure mode
 *     scoring.js's own module comment already rejects for classification.
 */

"use strict";

const QUALITY_TERNARY_VALUES = ["pass", "partial", "fail", "not_applicable"];
const QUALITY_HISTORY_USAGE_VALUES = ["appropriate", "neutral", "misleading", "not_clear"];

function zeroCounts(values) {
  const counts = {};
  for (const value of values) counts[value] = 0;
  return counts;
}

function ratio(correct, total) {
  return total === 0 ? null : correct / total;
}

function scoreSampleV2(sample) {
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
  // identical rule to scoring.js (v1).
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
// has already run validateDatasetV2() and confirmed dataset.valid.
function evaluateDatasetV2(dataset) {
  const samples = dataset.samples.map(scoreSampleV2);

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

module.exports = { evaluateDatasetV2 };
