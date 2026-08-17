/**
 * Deterministic, offline scoring for the QA Agent evaluation dataset
 * (scripts/ai/evaluation/dataset.json).
 *
 * Pure and side-effect free: no filesystem access, no environment
 * variables, no network, no provider imports. Takes an already-parsed,
 * already-validated dataset object and returns numbers - it never reads
 * dataset.json itself and never decides whether the dataset is well-formed
 * (that's dataset-schema.js's job, and evaluate.js's responsibility to call
 * before this module ever runs).
 *
 * Scores three things separately, on purpose:
 *   - classification accuracy (what the model said the failure was)
 *   - action accuracy (shouldRetry / final shouldCreateBug - what actually
 *     happened as a result)
 *   - qualitative aggregates (rootCause/evidence/recommendedFix/
 *     historyUsage - human curation of *how good* the reasoning was)
 * A single composite "QA score" would hide exactly which of these is
 * regressing, so this deliberately never combines them.
 */

"use strict";

const QUALITY_TERNARY_VALUES = ["pass", "partial", "fail", "not_applicable"];
const QUALITY_HISTORY_USAGE_VALUES = ["appropriate", "neutral", "misleading", "not_clear"];

function zeroCounts(values) {
  const counts = {};
  for (const value of values) counts[value] = 0;
  return counts;
}

// correct/total, or null when total is 0 - never NaN/Infinity, and never a
// string, so callers can still do math on it before formatting for display.
function ratio(correct, total) {
  return total === 0 ? null : correct / total;
}

function scoreSample(sample) {
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

  // Scored against finalShouldCreateBug (the post-agent-policy action),
  // never originalShouldCreateBug (the raw LLM recommendation) - the
  // dataset/application distinguish "what the model proposed" from "what
  // was actually allowed to happen", and only the latter is a real action.
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
  };
}

// Pure function: dataset in, { metrics, samples } out. Assumes the caller
// has already run validateDataset() and confirmed dataset.valid - this
// never re-validates shape, so a malformed dataset produces undefined
// behavior here rather than a clear error.
function evaluateDataset(dataset) {
  const samples = dataset.samples.map(scoreSample);

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

  for (const sample of samples) {
    rootCause[sample.quality.rootCause] += 1;
    evidence[sample.quality.evidence] += 1;
    recommendedFix[sample.quality.recommendedFix] += 1;
    historyUsage[sample.quality.historyUsage] += 1;
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
  };

  return { metrics, samples };
}

module.exports = { evaluateDataset };
