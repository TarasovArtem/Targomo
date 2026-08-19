/**
 * Schema/validator for the frozen QA Agent regression Baseline v5
 * (scripts/ai/evaluation/baseline-v5.json).
 *
 * Separate from baseline-schema.js (v1), baseline-v2-schema.js (v2),
 * baseline-v3-schema.js (v3), and baseline-v4-schema.js (v4) - all four
 * stay untouched. Derived from baseline-v4-schema.js's ten per-sample
 * fields (classificationStatus/shouldRetryCorrect/shouldCreateBugCorrect/
 * fabricatedEvidence/rootCause/evidence/recommendedFix/
 * correlationConstruction/correlationTransport/correlationReasoning) plus
 * five new ones justified by Roadmap #16D's K1-K5 evidence:
 *   - modelShouldCreateBugCorrect (boolean or null - see below)
 *   - knowledgeSelectionCorrect ("pass"/"fail"/"not_applicable")
 *   - knowledgeUsage (ternary)
 *   - knowledgeGrounding (ternary)
 *   - inferenceQuality (ternary or null)
 *
 * `datasetVersion` fixed to 5. All fifteen per-sample fields are
 * mechanically derived from Dataset v5's own curated/derived fields - never
 * recurated here. Same "do not duplicate the whole dataset, only freeze the
 * evaluation status" design as v1-v4. Sample-set parity against the
 * current dataset is deliberately NOT checked here - that is
 * regression-v5.js's responsibility.
 *
 * Baseline v5, like Baseline v4, intentionally does NOT carry dataset-only
 * provenance fields (revalidationOfExperiment/providerAttempts/
 * firstAttemptError, originalShouldCreateBug itself) - those describe HOW a
 * live observation was produced, not part of the frozen regression
 * comparison point.
 *
 * modelShouldCreateBugCorrect and inferenceQuality both allow `null`
 * ("not evaluated") in addition to their normal value set - inherited v4
 * samples may genuinely lack a curated inferenceQuality judgment (Roadmap
 * #16D: "do not fabricate historical evaluation metadata"), and a future
 * inherited generation could in principle lack originalShouldCreateBug.
 * `null` here is a real, distinct baseline state, never silently coerced
 * into "pass" or into "not_applicable" by regression-v5.js - see that
 * module's compareModelShouldCreateBugCorrect()/compareQualityTernaryOrNull().
 *
 * Pure, synchronous, offline: no filesystem access, no environment
 * variables, no network - same discipline as baseline-v4-schema.js.
 */

"use strict";

const SUPPORTED_VERSIONS = [1];

const CLASSIFICATION_STATUS_VALUES = ["pass", "fail", "ambiguous"];
const QUALITY_TERNARY_VALUES = ["pass", "partial", "fail", "not_applicable"];
const CORRELATION_QUALITY_VALUES = QUALITY_TERNARY_VALUES;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function isBooleanOrNull(value) {
  return value === null || typeof value === "boolean";
}

function validateBaselineV5(baseline) {
  const errors = [];

  if (!isPlainObject(baseline)) {
    return { valid: false, errors: ["baseline: must be an object"] };
  }

  if (!SUPPORTED_VERSIONS.includes(baseline.version)) {
    errors.push(`baseline.version: must be one of ${SUPPORTED_VERSIONS.join(", ")}`);
  }

  if (baseline.datasetVersion !== 5) {
    errors.push("baseline.datasetVersion: must be 5");
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
    if (!isBooleanOrNull(sample.modelShouldCreateBugCorrect)) {
      errors.push(`${path}.modelShouldCreateBugCorrect: must be a boolean or null`);
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
    if (!QUALITY_TERNARY_VALUES.includes(sample.knowledgeSelectionCorrect)) {
      errors.push(`${path}.knowledgeSelectionCorrect: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
    }
    if (!QUALITY_TERNARY_VALUES.includes(sample.knowledgeUsage)) {
      errors.push(`${path}.knowledgeUsage: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
    }
    if (!QUALITY_TERNARY_VALUES.includes(sample.knowledgeGrounding)) {
      errors.push(`${path}.knowledgeGrounding: must be one of ${QUALITY_TERNARY_VALUES.join(", ")}`);
    }
    if (sample.inferenceQuality !== null && !QUALITY_TERNARY_VALUES.includes(sample.inferenceQuality)) {
      errors.push(`${path}.inferenceQuality: must be one of ${QUALITY_TERNARY_VALUES.join(", ")} or null`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateBaselineV5, CLASSIFICATION_STATUS_VALUES, CORRELATION_QUALITY_VALUES, QUALITY_TERNARY_VALUES };
