/**
 * Schema/validator for the frozen QA Agent regression baseline
 * (scripts/ai/evaluation/baseline-v1.json).
 *
 * The baseline deliberately does NOT duplicate Dataset v1 - it only records
 * the evaluation *status* each sample had when the baseline was frozen
 * (classificationStatus/shouldRetryCorrect/shouldCreateBugCorrect), which is
 * all regression.js needs to detect per-sample drift later.
 *
 * Samples are keyed by ID in a plain object rather than an array, so
 * uniqueness is enforced for free by JavaScript object semantics - no
 * separate duplicate-ID check is needed here.
 *
 * Pure, synchronous, offline: no filesystem access, no environment
 * variables, no network - same contract as dataset-schema.js.
 */

"use strict";

const SUPPORTED_VERSIONS = [1];

const CLASSIFICATION_STATUS_VALUES = ["pass", "fail", "ambiguous"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function validateBaseline(baseline) {
  const errors = [];

  if (!isPlainObject(baseline)) {
    return { valid: false, errors: ["baseline: must be an object"] };
  }

  if (!SUPPORTED_VERSIONS.includes(baseline.version)) {
    errors.push(`baseline.version: must be one of ${SUPPORTED_VERSIONS.join(", ")}`);
  }

  if (typeof baseline.datasetVersion !== "number") {
    errors.push("baseline.datasetVersion: must be a number");
  }

  if (!isPlainObject(baseline.samples)) {
    errors.push("baseline.samples: must be an object");
    return { valid: errors.length === 0, errors };
  }

  const ids = Object.keys(baseline.samples);
  if (ids.length === 0) {
    errors.push("baseline.samples: must contain at least one sample");
  }

  for (const id of ids) {
    const sample = baseline.samples[id];
    const path = `baseline.samples["${id}"]`;

    if (!isPlainObject(sample)) {
      errors.push(`${path}: must be an object`);
      continue;
    }

    if (!CLASSIFICATION_STATUS_VALUES.includes(sample.classificationStatus)) {
      errors.push(`${path}.classificationStatus: must be one of ${CLASSIFICATION_STATUS_VALUES.join(", ")}`);
    }
    if (!isBoolean(sample.shouldRetryCorrect)) {
      errors.push(`${path}.shouldRetryCorrect: must be a boolean`);
    }
    if (!isBoolean(sample.shouldCreateBugCorrect)) {
      errors.push(`${path}.shouldCreateBugCorrect: must be a boolean`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateBaseline, CLASSIFICATION_STATUS_VALUES };
