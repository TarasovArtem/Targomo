/**
 * Schema/validator for the QA Agent evaluation Dataset v4
 * (scripts/ai/evaluation/dataset-v4.json).
 *
 * Dataset v4 is a SEPARATE, additive dataset - it does not replace or modify
 * Dataset v1 (dataset.json), Dataset v2 (dataset-v2.json), or Dataset v3
 * (dataset-v3.json), all of which remain frozen historical evidence with
 * their own schemas. This file is structurally identical to
 * dataset-v3-schema.js for every field v3 already validates (same "small
 * duplicated primitives, not a shared refactor" trade-off used throughout
 * this directory - v3's validator can never be broken by a v4 change and
 * vice versa), with SUPPORTED_VERSIONS changed to [4] and one additive
 * extension: sample.metadata may now carry three v4-only provenance fields -
 * revalidationOfExperiment, providerAttempts, firstAttemptError - used to
 * record which historical experiment a post-prompt re-validation sample
 * repeats, and how many live provider attempts that repeat actually took.
 * These are honest provenance/diagnostic facts, not quality judgments: they
 * are validated here but never fed into scoring-v4.js's or regression-v4.js's
 * pass/partial/fail or improvement/regression logic (see those modules'
 * own comments for why).
 *
 * Pure, synchronous, offline: no filesystem access, no environment
 * variables, no network - same discipline as dataset-v3-schema.js.
 */

"use strict";

const { CLASSIFICATIONS } = require("../qa-agent-prompt");

const SUPPORTED_VERSIONS = [4];

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

// Validates sample.correlation - the ground-truth/observed-context block,
// deliberately separate from sample.quality's correlation* judgment fields.
// Identical to dataset-v3-schema.js's collectCorrelationErrors.
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

  // applicable === true
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

// Validates the three v4-only provenance fields on sample.metadata, when
// present. Deliberately optional (v3-migrated samples in v4 carry none of
// them) - only enforces shape when a value has actually been supplied,
// never requires these fields to exist.
function collectProvenanceErrors(metadata, errors, path) {
  if (metadata.revalidationOfExperiment !== undefined) {
    if (typeof metadata.revalidationOfExperiment !== "number" && typeof metadata.revalidationOfExperiment !== "string") {
      errors.push(`${path}.revalidationOfExperiment: must be a number or a string when present`);
    }
  }
  if (metadata.providerAttempts !== undefined) {
    if (!Number.isInteger(metadata.providerAttempts) || metadata.providerAttempts < 1) {
      errors.push(`${path}.providerAttempts: must be a positive integer when present`);
    }
  }
  if (metadata.firstAttemptError !== undefined) {
    if (metadata.firstAttemptError !== null && !isNonEmptyString(metadata.firstAttemptError)) {
      errors.push(`${path}.firstAttemptError: must be a non-empty string or null when present`);
    }
  }
  // providerAttempts and firstAttemptError are provenance about the SAME
  // live-provider sequence, so their presence must agree: a firstAttemptError
  // string implies more than one attempt was made, and a single successful
  // attempt implies no first-attempt error to report.
  if (typeof metadata.providerAttempts === "number" && typeof metadata.firstAttemptError === "string") {
    if (metadata.providerAttempts < 2) {
      errors.push(`${path}: firstAttemptError is a non-null string but providerAttempts is less than 2`);
    }
  }
  if (typeof metadata.providerAttempts === "number" && metadata.providerAttempts === 1 && metadata.firstAttemptError !== null && metadata.firstAttemptError !== undefined) {
    errors.push(`${path}.firstAttemptError: must be null when providerAttempts is 1`);
  }
}

function collectSampleErrorsV4(sample, errors, pathPrefix) {
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

  let qualityClassification;
  let correlationConstruction;
  let correlationTransport;
  let correlationReasoning;
  if (!isPlainObject(sample.quality)) {
    errors.push(`${path}.quality: must be an object`);
  } else {
    const quality = sample.quality;
    qualityClassification = quality.classification;
    correlationConstruction = quality.correlationConstruction;
    correlationTransport = quality.correlationTransport;
    correlationReasoning = quality.correlationReasoning;

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
  }

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

  // Bidirectional: correlation.applicable === false iff all three
  // correlation quality fields are "not_applicable".
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
    collectProvenanceErrors(metadata, errors, `${path}.metadata`);
  }
}

function validateSampleV4(sample) {
  const errors = [];
  collectSampleErrorsV4(sample, errors, "sample");
  return { valid: errors.length === 0, errors };
}

function validateDatasetV4(dataset) {
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
    collectSampleErrorsV4(sample, errors, path);

    if (isPlainObject(sample) && isNonEmptyString(sample.id)) {
      if (seenIds.has(sample.id)) {
        errors.push(`${path}.id: duplicate sample id "${sample.id}"`);
      }
      seenIds.add(sample.id);
    }
  });

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateDatasetV4,
  validateSampleV4,
  QUALITY_TERNARY_VALUES,
  FAILURE_SCOPE_VALUES,
};
