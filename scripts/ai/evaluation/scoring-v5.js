/**
 * Deterministic, offline scoring for the QA Agent evaluation Dataset v5
 * (scripts/ai/evaluation/dataset-v5.json).
 *
 * Structurally derived from scoring-v4.js (same classification/shouldRetry/
 * shouldCreateBug semantics, same qualitative aggregates, same
 * evidenceGrounding boolean count, same correlation quality aggregates),
 * kept as its own module for the same reason v1/v2/v3/v4 stay separate:
 * Dataset v4 and Baseline v4 must never be put at risk by a v5 change, and
 * vice versa.
 *
 * Two additions, both derived from Roadmap #16D's K1-K5 controlled
 * knowledge-validation evidence, neither adding a stored dataset field:
 *
 *   - modelShouldCreateBugCorrect: sample.actual.originalShouldCreateBug
 *     compared against sample.groundTruth.shouldCreateBug - the RAW model
 *     decision, before policy. This is fully derivable from fields v4
 *     already stores (originalShouldCreateBug has been required on every
 *     v4 sample since Roadmap #13), so it is never itself persisted in the
 *     dataset - exactly the same "derive, don't duplicate" relationship
 *     the existing shouldCreateBug dimension already has with
 *     finalShouldCreateBug. K3 is the concrete case where this diverges
 *     from the existing shouldCreateBug dimension: model wrong
 *     (originalShouldCreateBug=true for a TEST_BUG), policy correct
 *     (finalShouldCreateBug=false) - see scoring-v5.test.js.
 *
 *   - knowledgeSelectionCorrect: derived from sample.knowledge (a new v5
 *     field - see dataset-v5-schema.js) using presence/absence/optional-
 *     exact-set semantics, never a stored curated value. Represented with
 *     the same three-state shape ("pass"/"fail"/"not_applicable") the
 *     existing correlationConstruction/Transport/Reasoning dimensions
 *     already use, gated by sample.knowledge.applicable exactly as those
 *     three are gated by sample.correlation.applicable.
 *
 * Existing shouldCreateBug scoring is UNCHANGED: still scored against
 * finalShouldCreateBug only, never originalShouldCreateBug - identical
 * rule to scoring.js/scoring-v2.js/scoring-v3.js/scoring-v4.js.
 */

"use strict";

const QUALITY_TERNARY_VALUES = ["pass", "partial", "fail", "not_applicable"];
const QUALITY_HISTORY_USAGE_VALUES = ["appropriate", "neutral", "misleading", "not_clear"];

function zeroCounts(values) {
  const counts = {};
  for (const value of values) counts[value] = 0;
  return counts;
}

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

// Presence: every expectedPresentUnitId must appear in actualSelectedUnitIds.
// Absence: no expectedAbsentUnitId may appear in actualSelectedUnitIds.
// Exact (only when expectedExactSelectedUnitIds is defined): actualSelectedUnitIds
// must equal it exactly, as a set (order-independent).
//
// Returns "pass" | "fail" | "not_applicable" - never a plain boolean, so it
// composes with the existing compareQualityTernary-style regression
// comparator (regression-v5.js) the same way correlationConstruction/
// Transport/Reasoning already do, rather than inventing a second N/A
// convention for a derived (not curated) dimension.
function scoreKnowledgeSelection(knowledge) {
  if (!knowledge || knowledge.applicable !== true) return "not_applicable";

  const actual = new Set(knowledge.actualSelectedUnitIds || []);

  const presenceOk = (knowledge.expectedPresentUnitIds || []).every((id) => actual.has(id));
  const absenceOk = (knowledge.expectedAbsentUnitIds || []).every((id) => !actual.has(id));

  let exactOk = true;
  if (Array.isArray(knowledge.expectedExactSelectedUnitIds)) {
    const expectedExact = new Set(knowledge.expectedExactSelectedUnitIds);
    exactOk = expectedExact.size === actual.size && [...expectedExact].every((id) => actual.has(id));
  }

  return presenceOk && absenceOk && exactOk ? "pass" : "fail";
}

// modelShouldCreateBugCorrect is a plain boolean (never "not_applicable"):
// every v5 sample - inherited or new - carries both
// actual.originalShouldCreateBug and groundTruth.shouldCreateBug as
// required boolean fields (dataset-v5-schema.js), so there is no
// structural "nothing to compare" case the way there is for
// knowledge/correlation. If a future inherited generation ever lacks
// originalShouldCreateBug, this returns null (not_evaluated) rather than
// guessing - see dataset-v5.test.js's inherited-sample tests.
function scoreModelShouldCreateBugCorrect(actual, groundTruth) {
  if (!actual || typeof actual.originalShouldCreateBug !== "boolean") return null;
  if (!groundTruth || typeof groundTruth.shouldCreateBug !== "boolean") return null;
  return actual.originalShouldCreateBug === groundTruth.shouldCreateBug;
}

function scoreSampleV5(sample) {
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
  // identical rule to scoring.js/scoring-v2.js/scoring-v3.js/scoring-v4.js.
  const shouldCreateBug = {
    correct: sample.actual.finalShouldCreateBug === sample.groundTruth.shouldCreateBug,
    expected: sample.groundTruth.shouldCreateBug,
    actual: sample.actual.finalShouldCreateBug,
  };

  const modelShouldCreateBugCorrect = scoreModelShouldCreateBugCorrect(sample.actual, sample.groundTruth);
  const knowledgeSelectionCorrect = scoreKnowledgeSelection(sample.knowledge);

  return {
    id: sample.id,
    isAmbiguous,
    classification,
    shouldRetry,
    shouldCreateBug,
    modelShouldCreateBugCorrect,
    knowledgeSelectionCorrect,
    policyAdjusted: sample.actual.policyAdjusted === true,
    quality: sample.quality,
    correlationApplicable: sample.correlation.applicable === true,
    knowledgeApplicable: sample.knowledge.applicable === true,
  };
}

// Pure function: dataset in, { metrics, samples } out. Assumes the caller
// has already run validateDatasetV5() and confirmed dataset.valid.
// Deliberately reads only dataset.samples - dataset.historicalObservations
// (if present, e.g. K2) is never passed through scoreSampleV5 and never
// contributes to any metric here, by construction, not by a runtime
// filter - see dataset-v5-schema.js's module comment for why.
function evaluateDatasetV5(dataset) {
  const samples = dataset.samples.map(scoreSampleV5);

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

  const modelShouldCreateBugEvaluable = samples.filter((s) => s.modelShouldCreateBugCorrect !== null);
  const modelShouldCreateBugCorrectCount = modelShouldCreateBugEvaluable.filter((s) => s.modelShouldCreateBugCorrect === true).length;
  const modelShouldCreateBugIncorrectCount = modelShouldCreateBugEvaluable.filter((s) => s.modelShouldCreateBugCorrect === false).length;
  const modelShouldCreateBugNotEvaluated = totalSamples - modelShouldCreateBugEvaluable.length;

  const policyInterventions = samples.filter((s) => s.policyAdjusted).length;

  const rootCause = zeroCounts(QUALITY_TERNARY_VALUES);
  const evidence = zeroCounts(QUALITY_TERNARY_VALUES);
  const recommendedFix = zeroCounts(QUALITY_TERNARY_VALUES);
  const historyUsage = zeroCounts(QUALITY_HISTORY_USAGE_VALUES);
  const knowledgeUsage = zeroCounts(QUALITY_TERNARY_VALUES);
  const knowledgeGrounding = zeroCounts(QUALITY_TERNARY_VALUES);
  // inferenceQuality additionally tracks a "not_evaluated" bucket (null in
  // the dataset) distinct from "not_applicable" - see dataset-v5-schema.js.
  const inferenceQuality = { ...zeroCounts(QUALITY_TERNARY_VALUES), not_evaluated: 0 };
  const knowledgeSelectionCorrect = zeroCounts(QUALITY_TERNARY_VALUES);

  const correlationConstruction = zeroCounts(QUALITY_TERNARY_VALUES);
  const correlationTransport = zeroCounts(QUALITY_TERNARY_VALUES);
  const correlationReasoning = zeroCounts(QUALITY_TERNARY_VALUES);

  let correlationApplicable = 0;
  let knowledgeApplicable = 0;

  for (const sample of samples) {
    rootCause[sample.quality.rootCause] += 1;
    evidence[sample.quality.evidence] += 1;
    recommendedFix[sample.quality.recommendedFix] += 1;
    historyUsage[sample.quality.historyUsage] += 1;
    knowledgeUsage[sample.quality.knowledgeUsage] += 1;
    knowledgeGrounding[sample.quality.knowledgeGrounding] += 1;
    inferenceQuality[sample.quality.inferenceQuality === null ? "not_evaluated" : sample.quality.inferenceQuality] += 1;
    knowledgeSelectionCorrect[sample.knowledgeSelectionCorrect] += 1;

    correlationConstruction[sample.quality.correlationConstruction] += 1;
    correlationTransport[sample.quality.correlationTransport] += 1;
    correlationReasoning[sample.quality.correlationReasoning] += 1;

    if (sample.correlationApplicable) correlationApplicable += 1;
    if (sample.knowledgeApplicable) knowledgeApplicable += 1;
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
    modelShouldCreateBugCorrect: modelShouldCreateBugCorrectCount,
    modelShouldCreateBugIncorrect: modelShouldCreateBugIncorrectCount,
    modelShouldCreateBugNotEvaluated,
    modelShouldCreateBugAccuracy: ratio(modelShouldCreateBugCorrectCount, modelShouldCreateBugEvaluable.length),
    policyInterventions,
    qualitative: { rootCause, evidence, recommendedFix, historyUsage, knowledgeUsage, knowledgeGrounding, inferenceQuality },
    evidenceGrounding: { fabricatedEvidence: countFabricatedEvidence(samples) },
    knowledge: {
      applicable: knowledgeApplicable,
      notApplicable: totalSamples - knowledgeApplicable,
      selectionCorrect: knowledgeSelectionCorrect,
    },
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

module.exports = { evaluateDatasetV5, scoreSampleV5, scoreKnowledgeSelection, scoreModelShouldCreateBugCorrect };
