/**
 * Schema/validator for the frozen QA Agent regression Baseline v2
 * (scripts/ai/evaluation/baseline-v2.json).
 *
 * Separate from baseline-schema.js (Baseline v1) - v1 stays untouched. Same
 * "do not duplicate the whole dataset, only freeze the evaluation status"
 * design as v1, extended with three new per-sample correlation quality
 * fields (construction/transport/reasoning) and, per Roadmap #12, three
 * qualitative fields (rootCause/evidence/recommendedFix) mechanically
 * copied from Dataset v2's own curated quality fields - never recurated
 * here. Sample-set parity against the
 * current dataset is deliberately NOT checked here - that is
 * regression-v2.js's responsibility (compareEvaluationToBaselineV2()),
 * keeping "is this baseline file well-formed" separate from "does this
 * baseline match the dataset I'm comparing against right now".
 *
 * Pure, synchronous, offline: no filesystem access, no environment
 * variables, no network - same discipline as baseline-schema.js.
 */

"use strict";

const SUPPORTED_VERSIONS = [1];

const CLASSIFICATION_STATUS_VALUES = ["pass", "fail", "ambiguous"];
// Same four-value ternary enum used for both the correlation-quality fields
// and the (Roadmap #12) rootCause/evidence/recommendedFix fields - one
// constant, two names, so each call site still reads as "what kind of value
// is this" rather than forcing every reader back to the correlation-specific
// name for fields that have nothing to do with correlation.
const CORRELATION_QUALITY_VALUES = ["pass", "partial", "fail", "not_applicable"];
const QUALITY_TERNARY_VALUES = CORRELATION_QUALITY_VALUES;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function validateBaselineV2(baseline) {
  const errors = [];

  if (!isPlainObject(baseline)) {
    return { valid: false, errors: ["baseline: must be an object"] };
  }

  if (!SUPPORTED_VERSIONS.includes(baseline.version)) {
    errors.push(`baseline.version: must be one of ${SUPPORTED_VERSIONS.join(", ")}`);
  }

  if (baseline.datasetVersion !== 2) {
    errors.push("baseline.datasetVersion: must be 2");
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
    if (!isBoolean(sample.fabricatedEvidence)) {
      errors.push(`${path}.fabricatedEvidence: must be a boolean`);
    }
    if (!QUALITY_TERNARY_VALUES.includes(sample.rootCause)) {
      errors.push(`${path}.rootCause: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
    }
    if (!QUALITY_TERNARY_VALUES.includes(sample.evidence)) {
      errors.push(`${path}.evidence: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
    }
    if (!QUALITY_TERNARY_VALUES.includes(sample.recommendedFix)) {
      errors.push(`${path}.recommendedFix: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
    }
    if (!CORRELATION_QUALITY_VALUES.includes(sample.correlationConstruction)) {
      errors.push(`${path}.correlationConstruction: must be one of ${CORRELATION_QUALITY_VALUES.join(", ")}`);
    }
    if (!CORRELATION_QUALITY_VALUES.includes(sample.correlationTransport)) {
      errors.push(`${path}.correlationTransport: must be one of ${CORRELATION_QUALITY_VALUES.join(", ")}`);
    }
    if (!CORRELATION_QUALITY_VALUES.includes(sample.correlationReasoning)) {
      errors.push(`${path}.correlationReasoning: must be one of ${CORRELATION_QUALITY_VALUES.join(", ")}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateBaselineV2, CLASSIFICATION_STATUS_VALUES, CORRELATION_QUALITY_VALUES, QUALITY_TERNARY_VALUES };
