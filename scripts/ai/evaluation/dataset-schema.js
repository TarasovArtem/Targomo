/**
 * Schema/validator for the QA Agent evaluation dataset (scripts/ai/evaluation/dataset.json).
 *
 * Phase 1 only: this validates dataset *shape and internal consistency*. It
 * does not run any evaluation, scoring, or comparison against a live
 * provider - that's Phase 2 (a separate runner, not built here). Pure,
 * synchronous, offline: no filesystem access, no environment variables, no
 * network. Callers are responsible for loading dataset.json themselves and
 * passing the parsed object in.
 *
 * Reuses qa-agent-prompt.js's CLASSIFICATIONS as the one authoritative list
 * of valid classification values, the same way agent-policy.js and
 * mock-provider.js do - so this file can never silently drift from what the
 * production prompt/contract actually allows.
 */

"use strict";

const { CLASSIFICATIONS } = require("../qa-agent-prompt");

const SUPPORTED_VERSIONS = [1];

const QUALITY_CLASSIFICATION_VALUES = ["pass", "fail", "ambiguous"];
const QUALITY_TERNARY_VALUES = ["pass", "partial", "fail", "not_applicable"];
const QUALITY_HISTORY_USAGE_VALUES = ["appropriate", "neutral", "misleading", "not_clear"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Collects every problem instead of throwing on the first one, so a single
// validateDataset() call reports the full set of issues in a sample at once.
// Internal - shared by the public validateSample() and validateDataset()
// below, which both need to fold sample-level errors into a path-prefixed
// list rather than each getting their own isolated {valid, errors} result.
function collectSampleErrors(sample, errors, pathPrefix) {
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
  if (!isPlainObject(sample.quality)) {
    errors.push(`${path}.quality: must be an object`);
  } else {
    const quality = sample.quality;
    qualityClassification = quality.classification;
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

    // Bidirectional: ambiguity.isAmbiguous === true iff quality.classification === "ambiguous".
    if (isBoolean(isAmbiguous) && QUALITY_CLASSIFICATION_VALUES.includes(qualityClassification)) {
      if (isAmbiguous && qualityClassification !== "ambiguous") {
        errors.push(`${path}: ambiguity.isAmbiguous is true but quality.classification is "${qualityClassification}" (expected "ambiguous")`);
      }
      if (!isAmbiguous && qualityClassification === "ambiguous") {
        errors.push(`${path}: quality.classification is "ambiguous" but ambiguity.isAmbiguous is false`);
      }
    }
  }

  if (!isPlainObject(sample.metadata)) {
    errors.push(`${path}.metadata: must be an object`);
  } else {
    const metadata = sample.metadata;
    if (typeof metadata.experiment !== "number") {
      errors.push(`${path}.metadata.experiment: must be a number`);
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
  }
}

// Public single-sample entry point, e.g. for validating one sample in
// isolation before adding it to dataset.json.
function validateSample(sample) {
  const errors = [];
  collectSampleErrors(sample, errors, "sample");
  return { valid: errors.length === 0, errors };
}

function validateDataset(dataset) {
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
    collectSampleErrors(sample, errors, path);

    if (isPlainObject(sample) && isNonEmptyString(sample.id)) {
      if (seenIds.has(sample.id)) {
        errors.push(`${path}.id: duplicate sample id "${sample.id}"`);
      }
      seenIds.add(sample.id);
    }
  });

  return { valid: errors.length === 0, errors };
}

module.exports = { validateDataset, validateSample };
