/**
 * Schema/validator for the QA Agent evaluation Dataset v5
 * (scripts/ai/evaluation/dataset-v5.json).
 *
 * Dataset v5 is a SEPARATE, additive dataset - it does not replace or modify
 * Dataset v1 (dataset.json), Dataset v2 (dataset-v2.json), Dataset v3
 * (dataset-v3.json), or Dataset v4 (dataset-v4.json), all of which remain
 * frozen historical evidence with their own schemas. Same "small duplicated
 * primitives, not a shared refactor" trade-off used throughout this
 * directory - v4's validator can never be broken by a v5 change and vice
 * versa.
 *
 * Roadmap #16D/#16E.1: v5 is additive over v4's sample shape in exactly two
 * ways, both driven by concrete failure modes observed in the K1-K5
 * controlled knowledge-validation experiments (not speculative):
 *
 *   1. sample.knowledge - the selector's expected/actual knowledge-unit
 *      selection for this sample, mirroring sample.correlation's existing
 *      applicable/observed shape. Never required to assert an exact
 *      selected set (K2's mistake); presence/absence subset semantics are
 *      the default, with an optional exact-set assertion only when the
 *      curator genuinely knows the complete frozen context (K5's shape).
 *
 *   2. Three new sample.quality ternary dimensions - knowledgeUsage,
 *      knowledgeGrounding, inferenceQuality - alongside the existing
 *      rootCause/evidence/recommendedFix/correlation* ternaries, using the
 *      identical QUALITY_TERNARY_VALUES enum. inferenceQuality additionally
 *      allows `null` (meaning "not yet curated for this sample", distinct
 *      from "not_applicable" meaning "structurally nothing to judge" - see
 *      the module comment on collectQualityErrorsV5 below).
 *
 * Also additive: sample.quality.modelShouldCreateBugCorrect is NOT stored
 * here - it is fully derivable from the already-existing
 * sample.actual.originalShouldCreateBug and sample.groundTruth.shouldCreateBug
 * (exactly the same relationship v1-v4 already use to derive shouldCreateBug
 * correctness from actual.finalShouldCreateBug), so storing it would be
 * redundant provenance. It is computed in scoring-v5.js, not validated here
 * beyond the existing actual.originalShouldCreateBug/groundTruth.shouldCreateBug
 * checks already inherited from v4.
 *
 * Dataset v5 also carries an optional, structurally separate
 * historicalObservations array - frozen historical provenance (K2) that
 * must never be scored as an ordinary pass/fail sample. See the module
 * comment on collectHistoricalObservationErrors below for why this is a
 * distinct top-level array rather than a "scorable: false" flag on an
 * ordinary sample: keeping it entirely out of `samples` guarantees
 * scoring-v5.js/regression-v5.js can never accidentally fold it into any
 * aggregate or regression tally, with no conditional branching required in
 * either hot path.
 *
 * Pure, synchronous, offline: no filesystem access, no environment
 * variables, no network - same discipline as dataset-v4-schema.js.
 */

"use strict";

const { CLASSIFICATIONS } = require("../qa-agent-prompt");

const SUPPORTED_VERSIONS = [5];

const QUALITY_CLASSIFICATION_VALUES = ["pass", "fail", "ambiguous"];
const QUALITY_TERNARY_VALUES = ["pass", "partial", "fail", "not_applicable"];
const QUALITY_HISTORY_USAGE_VALUES = ["appropriate", "neutral", "misleading", "not_clear"];
const FAILURE_SCOPE_VALUES = ["single-browser", "multi-browser"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isUniqueNonEmptyStringArray(value) {
  if (!isStringArray(value) || value.length === 0) return false;
  return new Set(value).size === value.length;
}

// Like isUniqueNonEmptyStringArray, but the array itself is allowed to be
// empty - unlike observed.browsers (which must name at least one browser),
// an empty knowledge-unit-id array is a meaningful, legitimate value (K5's
// exact zero-selection case: expectedPresentUnitIds/expectedExactSelectedUnitIds/
// actualSelectedUnitIds all []). Only non-empty arrays are checked for
// duplicate/blank entries; [] always passes.
function isUniqueStringArrayAllowEmpty(value) {
  if (!isStringArray(value)) return false;
  if (value.length === 0) return true;
  if (!value.every((v) => v.trim().length > 0)) return false;
  return new Set(value).size === value.length;
}

// Identical to dataset-v4-schema.js's collectCorrelationErrors - v5
// introduces no change to correlation semantics.
function collectCorrelationErrors(sample, errors, path) {
  if (!isPlainObject(sample.correlation)) {
    errors.push(`${path}.correlation: must be an object`);
    return;
  }

  const correlation = sample.correlation;
  if (!isBoolean(correlation.applicable)) {
    errors.push(`${path}.correlation.applicable: must be a boolean`);
    return;
  }

  if (correlation.applicable === false) {
    if (correlation.observed !== null) {
      errors.push(`${path}.correlation.observed: must be null when correlation.applicable is false`);
    }
    return;
  }

  if (!isPlainObject(correlation.observed)) {
    errors.push(`${path}.correlation.observed: must be an object when correlation.applicable is true`);
    return;
  }

  const observed = correlation.observed;
  const observedPath = `${path}.correlation.observed`;

  const browsersValid = isUniqueNonEmptyStringArray(observed.browsers);
  if (!browsersValid) {
    errors.push(`${observedPath}.browsers: must be a non-empty array of unique strings`);
  }

  const failedValid = isStringArray(observed.failedBrowsers);
  if (!failedValid) {
    errors.push(`${observedPath}.failedBrowsers: must be an array of strings`);
  }

  const passedValid = isStringArray(observed.passedBrowsers);
  if (!passedValid) {
    errors.push(`${observedPath}.passedBrowsers: must be an array of strings`);
  }

  const additionalValid = isStringArray(observed.additionalFailedBrowsers);
  if (!additionalValid) {
    errors.push(`${observedPath}.additionalFailedBrowsers: must be an array of strings`);
  }

  if (observed.primaryBrowser !== null && typeof observed.primaryBrowser !== "string") {
    errors.push(`${observedPath}.primaryBrowser: must be a string or null`);
  }

  if (!FAILURE_SCOPE_VALUES.includes(observed.failureScope)) {
    errors.push(`${observedPath}.failureScope: must be one of ${FAILURE_SCOPE_VALUES.join(", ")}`);
  }

  if (observed.sameFailureSignature !== true && observed.sameFailureSignature !== false && observed.sameFailureSignature !== null) {
    errors.push(`${observedPath}.sameFailureSignature: must be true, false, or null`);
  }

  if (browsersValid && failedValid && passedValid) {
    const browsersSet = new Set(observed.browsers);
    for (const b of observed.failedBrowsers) {
      if (!browsersSet.has(b)) errors.push(`${observedPath}.failedBrowsers: "${b}" is not present in browsers`);
    }
    for (const b of observed.passedBrowsers) {
      if (!browsersSet.has(b)) errors.push(`${observedPath}.passedBrowsers: "${b}" is not present in browsers`);
    }
    const failedSet = new Set(observed.failedBrowsers);
    for (const b of observed.passedBrowsers) {
      if (failedSet.has(b)) errors.push(`${observedPath}: "${b}" cannot be both a failed and a passed browser`);
    }
  }

  if (failedValid) {
    if (observed.primaryBrowser !== null && typeof observed.primaryBrowser === "string" && !observed.failedBrowsers.includes(observed.primaryBrowser)) {
      errors.push(`${observedPath}.primaryBrowser: "${observed.primaryBrowser}" must be included in failedBrowsers`);
    }
    if (additionalValid) {
      for (const b of observed.additionalFailedBrowsers) {
        if (!observed.failedBrowsers.includes(b)) {
          errors.push(`${observedPath}.additionalFailedBrowsers: "${b}" must be included in failedBrowsers`);
        }
      }
      if (observed.primaryBrowser !== null && observed.additionalFailedBrowsers.includes(observed.primaryBrowser)) {
        errors.push(`${observedPath}.additionalFailedBrowsers: must not include primaryBrowser ("${observed.primaryBrowser}")`);
      }
    }
    if (observed.failureScope === "multi-browser" && observed.failedBrowsers.length <= 1) {
      errors.push(`${observedPath}.failureScope: "multi-browser" requires more than one failed browser`);
    }
    if (observed.failureScope === "single-browser" && observed.failedBrowsers.length !== 1) {
      errors.push(`${observedPath}.failureScope: "single-browser" requires exactly one failed browser`);
    }
  }
}

// New in v5. Mirrors sample.correlation's applicable/observed shape
// deliberately, for the same reason: "knowledge was not part of this run"
// (applicable=false, e.g. every v4-inherited pre-knowledge sample) must
// stay structurally distinguishable from "the knowledge selector ran and
// selected zero units" (applicable=true, actualSelectedUnitIds=[] - K5's
// shape). Pretending the former is the latter would be exactly the
// mistake Roadmap #16D's consolidation review explicitly rejected.
//
// expectedExactSelectedUnitIds is OPTIONAL even when applicable=true - K2
// demonstrated that asserting a global exact set before the real
// browserCorrelation-derived context is known is unsound; presence/absence
// subset semantics (expectedPresentUnitIds/expectedAbsentUnitIds) are the
// default, safe assertion shape. Only a curator who genuinely knows the
// complete frozen context (K5) should supply the exact-set field.
function collectKnowledgeErrors(sample, errors, path) {
  if (!isPlainObject(sample.knowledge)) {
    errors.push(`${path}.knowledge: must be an object`);
    return;
  }

  const knowledge = sample.knowledge;
  if (!isBoolean(knowledge.applicable)) {
    errors.push(`${path}.knowledge.applicable: must be a boolean`);
    return;
  }

  if (knowledge.applicable === false) {
    for (const field of ["expectedPresentUnitIds", "expectedAbsentUnitIds", "expectedExactSelectedUnitIds", "actualSelectedUnitIds"]) {
      if (knowledge[field] !== null) {
        errors.push(`${path}.knowledge.${field}: must be null when knowledge.applicable is false`);
      }
    }
    return;
  }

  // applicable === true. Each array - when present - must contain unique
  // non-empty string ids (isUniqueStringArrayAllowEmpty), not merely any
  // strings (isStringArray) - a curated dataset should fail loudly on a
  // duplicate/blank unit id rather than silently accept it, even though
  // scoreKnowledgeSelection() itself is Set-based and would never be
  // corrupted by a duplicate. [] remains valid (K5's exact zero-selection
  // shape), so this is deliberately NOT isUniqueNonEmptyStringArray (which
  // rejects the empty array outright).
  if (!isUniqueStringArrayAllowEmpty(knowledge.expectedPresentUnitIds)) {
    errors.push(`${path}.knowledge.expectedPresentUnitIds: must be an array of unique non-empty strings when knowledge.applicable is true`);
  }
  if (!isUniqueStringArrayAllowEmpty(knowledge.expectedAbsentUnitIds)) {
    errors.push(`${path}.knowledge.expectedAbsentUnitIds: must be an array of unique non-empty strings when knowledge.applicable is true`);
  }
  if (knowledge.expectedExactSelectedUnitIds !== null && !isUniqueStringArrayAllowEmpty(knowledge.expectedExactSelectedUnitIds)) {
    errors.push(`${path}.knowledge.expectedExactSelectedUnitIds: must be an array of unique non-empty strings, or null`);
  }
  if (!isUniqueStringArrayAllowEmpty(knowledge.actualSelectedUnitIds)) {
    errors.push(`${path}.knowledge.actualSelectedUnitIds: must be an array of unique non-empty strings when knowledge.applicable is true`);
  }

  // expectedPresentUnitIds and expectedAbsentUnitIds must never name the
  // same unit - a self-contradictory expectation the curator should never
  // be able to express, let alone one the scorer would silently reconcile.
  if (isStringArray(knowledge.expectedPresentUnitIds) && isStringArray(knowledge.expectedAbsentUnitIds)) {
    const absentSet = new Set(knowledge.expectedAbsentUnitIds);
    for (const id of knowledge.expectedPresentUnitIds) {
      if (absentSet.has(id)) {
        errors.push(`${path}.knowledge: "${id}" cannot appear in both expectedPresentUnitIds and expectedAbsentUnitIds`);
      }
    }
  }

  // When an exact set is asserted, it must actually be consistent with the
  // presence/absence expectations rather than silently overriding them.
  if (isStringArray(knowledge.expectedExactSelectedUnitIds) && isStringArray(knowledge.expectedPresentUnitIds) && isStringArray(knowledge.expectedAbsentUnitIds)) {
    const exactSet = new Set(knowledge.expectedExactSelectedUnitIds);
    for (const id of knowledge.expectedPresentUnitIds) {
      if (!exactSet.has(id)) {
        errors.push(`${path}.knowledge: expectedExactSelectedUnitIds is missing "${id}" from expectedPresentUnitIds`);
      }
    }
    for (const id of knowledge.expectedAbsentUnitIds) {
      if (exactSet.has(id)) {
        errors.push(`${path}.knowledge: expectedExactSelectedUnitIds contains "${id}" which is also in expectedAbsentUnitIds`);
      }
    }
  }
}

// inferenceQuality is the only v5 quality dimension that additionally
// accepts `null` ("not yet curated" - Roadmap #16D's consolidation review
// explicitly forbids guessing historical inference quality for samples
// inherited from before this dimension existed) alongside the normal
// QUALITY_TERNARY_VALUES set. `null` and "not_applicable" are deliberately
// DIFFERENT states here: "not_applicable" means the sample's output is
// essentially direct factual extraction with no meaningful inferential
// step to judge (K4/K5's shape); `null` means a meaningful inferential
// step exists but has not been curated yet. Regression/scoring must never
// collapse these two into each other or into "pass" - see
// regression-v5.js's compareQualityTernaryOrNull().
function collectQualityErrorsV5(sample, errors, path) {
  if (!isPlainObject(sample.quality)) {
    errors.push(`${path}.quality: must be an object`);
    return { qualityClassification: undefined, correlationConstruction: undefined, correlationTransport: undefined, correlationReasoning: undefined };
  }

  const quality = sample.quality;

  if (!QUALITY_CLASSIFICATION_VALUES.includes(quality.classification)) {
    errors.push(`${path}.quality.classification: must be one of ${QUALITY_CLASSIFICATION_VALUES.join(", ")}`);
  }
  if (!QUALITY_TERNARY_VALUES.includes(quality.rootCause)) {
    errors.push(`${path}.quality.rootCause: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
  }
  if (!QUALITY_TERNARY_VALUES.includes(quality.evidence)) {
    errors.push(`${path}.quality.evidence: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
  }
  if (!QUALITY_TERNARY_VALUES.includes(quality.recommendedFix)) {
    errors.push(`${path}.quality.recommendedFix: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
  }
  if (!QUALITY_HISTORY_USAGE_VALUES.includes(quality.historyUsage)) {
    errors.push(`${path}.quality.historyUsage: must be one of ${QUALITY_HISTORY_USAGE_VALUES.join(", ")}`);
  }
  if (!isBoolean(quality.fabricatedEvidence)) {
    errors.push(`${path}.quality.fabricatedEvidence: must be a boolean`);
  }
  if (!QUALITY_TERNARY_VALUES.includes(quality.correlationConstruction)) {
    errors.push(`${path}.quality.correlationConstruction: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
  }
  if (!QUALITY_TERNARY_VALUES.includes(quality.correlationTransport)) {
    errors.push(`${path}.quality.correlationTransport: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
  }
  if (!QUALITY_TERNARY_VALUES.includes(quality.correlationReasoning)) {
    errors.push(`${path}.quality.correlationReasoning: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
  }

  // New in v5.
  if (!QUALITY_TERNARY_VALUES.includes(quality.knowledgeUsage)) {
    errors.push(`${path}.quality.knowledgeUsage: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
  }
  if (!QUALITY_TERNARY_VALUES.includes(quality.knowledgeGrounding)) {
    errors.push(`${path}.quality.knowledgeGrounding: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
  }
  if (quality.inferenceQuality !== null && !QUALITY_TERNARY_VALUES.includes(quality.inferenceQuality)) {
    errors.push(`${path}.quality.inferenceQuality: must be one of ${QUALITY_TERNARY_VALUES.join(", ")} or null`);
  }

  // Bidirectional: knowledgeUsage/knowledgeGrounding must be "not_applicable"
  // iff there is no ACTUAL SELECTED KNOWLEDGE to use/ground - that is,
  // knowledge.applicable is false (selector never ran for this sample, e.g.
  // pre-knowledge inherited v4 samples) OR knowledge.applicable is true but
  // actualSelectedUnitIds is empty (the selector genuinely ran against the
  // full context and selected zero units - K5's shape). These are
  // deliberately different states (see the module comment on
  // collectKnowledgeErrors above) that both nonetheless mean "nothing for
  // the model to use or ground" - conflating "selector ran" with "selector
  // selected something" here would wrongly reject K5's own curated
  // not_applicable values.
  if (isPlainObject(sample.knowledge) && isBoolean(sample.knowledge.applicable)) {
    const applicable = sample.knowledge.applicable;
    const hasSelectedKnowledge = applicable && Array.isArray(sample.knowledge.actualSelectedUnitIds) && sample.knowledge.actualSelectedUnitIds.length > 0;
    for (const field of ["knowledgeUsage", "knowledgeGrounding"]) {
      const value = quality[field];
      if (QUALITY_TERNARY_VALUES.includes(value)) {
        if (!hasSelectedKnowledge && value !== "not_applicable") {
          errors.push(`${path}: no selected knowledge for this sample but quality.${field} is "${value}" (expected "not_applicable")`);
        }
        if (hasSelectedKnowledge && value === "not_applicable") {
          errors.push(`${path}: knowledge was actually selected for this sample but quality.${field} is "not_applicable"`);
        }
      }
    }
  }

  return {
    qualityClassification: quality.classification,
    correlationConstruction: quality.correlationConstruction,
    correlationTransport: quality.correlationTransport,
    correlationReasoning: quality.correlationReasoning,
  };
}

function collectSampleErrorsV5(sample, errors, pathPrefix) {
  const path = pathPrefix || "sample";

  if (!isPlainObject(sample)) {
    errors.push(`${path}: must be an object`);
    return;
  }

  if (!isNonEmptyString(sample.id)) {
    errors.push(`${path}.id: must be a non-empty string`);
  }

  if (!isNonEmptyString(sample.scenario)) {
    errors.push(`${path}.scenario: must be a non-empty string`);
  }

  if (sample.description !== undefined && typeof sample.description !== "string") {
    errors.push(`${path}.description: must be a string when present`);
  }

  if (!isPlainObject(sample.groundTruth)) {
    errors.push(`${path}.groundTruth: must be an object`);
  } else {
    const gt = sample.groundTruth;
    if (!CLASSIFICATIONS.includes(gt.classification)) {
      errors.push(`${path}.groundTruth.classification: must be one of ${CLASSIFICATIONS.join(", ")}`);
    }
    if (!isBoolean(gt.shouldRetry)) {
      errors.push(`${path}.groundTruth.shouldRetry: must be a boolean`);
    }
    if (!isBoolean(gt.shouldCreateBug)) {
      errors.push(`${path}.groundTruth.shouldCreateBug: must be a boolean`);
    }
  }

  if (!isPlainObject(sample.actual)) {
    errors.push(`${path}.actual: must be an object`);
  } else {
    const actual = sample.actual;
    if (!CLASSIFICATIONS.includes(actual.classification)) {
      errors.push(`${path}.actual.classification: must be one of ${CLASSIFICATIONS.join(", ")}`);
    }
    if (typeof actual.confidence !== "number" || Number.isNaN(actual.confidence) || actual.confidence < 0 || actual.confidence > 1) {
      errors.push(`${path}.actual.confidence: must be a number between 0 and 1`);
    }
    if (!isBoolean(actual.shouldRetry)) {
      errors.push(`${path}.actual.shouldRetry: must be a boolean`);
    }
    if (!isBoolean(actual.originalShouldCreateBug)) {
      errors.push(`${path}.actual.originalShouldCreateBug: must be a boolean`);
    }
    if (!isBoolean(actual.finalShouldCreateBug)) {
      errors.push(`${path}.actual.finalShouldCreateBug: must be a boolean`);
    }
    if (!isBoolean(actual.policyAdjusted)) {
      errors.push(`${path}.actual.policyAdjusted: must be a boolean`);
    }
  }

  const { qualityClassification, correlationConstruction, correlationTransport, correlationReasoning } = collectQualityErrorsV5(sample, errors, path);

  let isAmbiguous;
  if (!isPlainObject(sample.ambiguity)) {
    errors.push(`${path}.ambiguity: must be an object`);
  } else {
    const ambiguity = sample.ambiguity;
    isAmbiguous = ambiguity.isAmbiguous;
    if (!isBoolean(ambiguity.isAmbiguous)) {
      errors.push(`${path}.ambiguity.isAmbiguous: must be a boolean`);
    } else if (ambiguity.isAmbiguous) {
      if (!isNonEmptyString(ambiguity.reason)) {
        errors.push(`${path}.ambiguity.reason: must be a non-empty string when isAmbiguous is true`);
      }
    } else if (ambiguity.reason !== null) {
      errors.push(`${path}.ambiguity.reason: must be null when isAmbiguous is false`);
    }

    if (isBoolean(isAmbiguous) && QUALITY_CLASSIFICATION_VALUES.includes(qualityClassification)) {
      if (isAmbiguous && qualityClassification !== "ambiguous") {
        errors.push(`${path}: ambiguity.isAmbiguous is true but quality.classification is "${qualityClassification}" (expected "ambiguous")`);
      }
      if (!isAmbiguous && qualityClassification === "ambiguous") {
        errors.push(`${path}: quality.classification is "ambiguous" but ambiguity.isAmbiguous is false`);
      }
    }
  }

  collectCorrelationErrors(sample, errors, path);
  collectKnowledgeErrors(sample, errors, path);

  if (isPlainObject(sample.correlation) && isBoolean(sample.correlation.applicable)) {
    const applicable = sample.correlation.applicable;
    const correlationFields = [
      ["correlationConstruction", correlationConstruction],
      ["correlationTransport", correlationTransport],
      ["correlationReasoning", correlationReasoning],
    ];
    for (const [name, value] of correlationFields) {
      if (QUALITY_TERNARY_VALUES.includes(value)) {
        if (!applicable && value !== "not_applicable") {
          errors.push(`${path}: correlation.applicable is false but quality.${name} is "${value}" (expected "not_applicable")`);
        }
        if (applicable && value === "not_applicable") {
          errors.push(`${path}: correlation.applicable is true but quality.${name} is "not_applicable"`);
        }
      }
    }
  }

  if (!isPlainObject(sample.metadata)) {
    errors.push(`${path}.metadata: must be an object`);
  } else {
    const metadata = sample.metadata;
    if (typeof metadata.experiment !== "number" && typeof metadata.experiment !== "string") {
      errors.push(`${path}.metadata.experiment: must be a number or a string`);
    }
    if (!isNonEmptyString(metadata.provider)) {
      errors.push(`${path}.metadata.provider: must be a non-empty string`);
    }
    if (!isNonEmptyString(metadata.model)) {
      errors.push(`${path}.metadata.model: must be a non-empty string`);
    }
    if (typeof metadata.PR !== "number") {
      errors.push(`${path}.metadata.PR: must be a number`);
    }
    if (typeof metadata.workflowRun !== "number") {
      errors.push(`${path}.metadata.workflowRun: must be a number`);
    }
    if (metadata.revalidationOfExperiment !== undefined) {
      if (typeof metadata.revalidationOfExperiment !== "number" && typeof metadata.revalidationOfExperiment !== "string") {
        errors.push(`${path}.metadata.revalidationOfExperiment: must be a number or a string when present`);
      }
    }
    if (metadata.providerAttempts !== undefined) {
      if (!Number.isInteger(metadata.providerAttempts) || metadata.providerAttempts < 1) {
        errors.push(`${path}.metadata.providerAttempts: must be a positive integer when present`);
      }
    }
    if (metadata.firstAttemptError !== undefined) {
      if (metadata.firstAttemptError !== null && !isNonEmptyString(metadata.firstAttemptError)) {
        errors.push(`${path}.metadata.firstAttemptError: must be a non-empty string or null when present`);
      }
    }
  }
}

// Historical observations are frozen provenance records, not scorable
// samples - deliberately validated with a much lighter shape than
// collectSampleErrorsV5, since they carry no groundTruth/actual pair to
// score against. K2 (Roadmap #16D) is the only current entry: its original
// predeclared relevantKnowledge=[] hypothesis failed, but the run remains
// valuable historical evidence (target timeout/retry exclusion succeeded;
// the two units it did select were semantically legitimate for the
// realized sameFailureSignature=false context; the run exposed the
// cross-browser selector overbreadth defect later fixed by PR #54).
function collectHistoricalObservationErrors(observation, errors, path) {
  if (!isPlainObject(observation)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  if (!isNonEmptyString(observation.id)) {
    errors.push(`${path}.id: must be a non-empty string`);
  }
  if (!isNonEmptyString(observation.summary)) {
    errors.push(`${path}.summary: must be a non-empty string`);
  }
  if (!isNonEmptyString(observation.reason)) {
    errors.push(`${path}.reason: must be a non-empty string explaining why this is historical-only, not a scorable sample`);
  }
  if (!isPlainObject(observation.metadata)) {
    errors.push(`${path}.metadata: must be an object`);
  }
}

function validateSampleV5(sample) {
  const errors = [];
  collectSampleErrorsV5(sample, errors, "sample");
  return { valid: errors.length === 0, errors };
}

function validateDatasetV5(dataset) {
  const errors = [];

  if (!isPlainObject(dataset)) {
    return { valid: false, errors: ["dataset: must be an object"] };
  }

  if (!SUPPORTED_VERSIONS.includes(dataset.version)) {
    errors.push(`dataset.version: must be one of ${SUPPORTED_VERSIONS.join(", ")}`);
  }

  if (!Array.isArray(dataset.samples)) {
    errors.push("dataset.samples: must be an array");
    return { valid: errors.length === 0, errors };
  }

  const seenIds = new Set();
  dataset.samples.forEach((sample, index) => {
    const path = `dataset.samples[${index}]`;
    collectSampleErrorsV5(sample, errors, path);

    if (isPlainObject(sample) && isNonEmptyString(sample.id)) {
      if (seenIds.has(sample.id)) {
        errors.push(`${path}.id: duplicate sample id "${sample.id}"`);
      }
      seenIds.add(sample.id);
    }
  });

  // Optional: historicalObservations, when present, must be an array of
  // valid (lightweight) records, and must never share an id with a
  // scorable sample - a shared id would make it ambiguous which one a
  // future lookup by id means.
  if (dataset.historicalObservations !== undefined) {
    if (!Array.isArray(dataset.historicalObservations)) {
      errors.push("dataset.historicalObservations: must be an array when present");
    } else {
      dataset.historicalObservations.forEach((observation, index) => {
        const path = `dataset.historicalObservations[${index}]`;
        collectHistoricalObservationErrors(observation, errors, path);
        if (isPlainObject(observation) && isNonEmptyString(observation.id)) {
          if (seenIds.has(observation.id)) {
            errors.push(`${path}.id: "${observation.id}" collides with a scorable sample id or another historical observation`);
          }
          seenIds.add(observation.id);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateDatasetV5,
  validateSampleV5,
  QUALITY_TERNARY_VALUES,
  QUALITY_HISTORY_USAGE_VALUES,
  FAILURE_SCOPE_VALUES,
};
