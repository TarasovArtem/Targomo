/**
 * Schema/validator for a single QA Knowledge unit
 * (scripts/ai/knowledge/units/*.json).
 *
 * A knowledge unit is GUIDANCE, never current-run EVIDENCE (see Roadmap
 * #15A). This module only validates the shape/content of one unit in
 * isolation - it has no awareness of other units, so it cannot detect
 * duplicate ids across files (that is loader.js's job, since only the
 * loader ever sees more than one unit at a time).
 *
 * Deliberately minimal, following the same "small duplicated primitives,
 * not a shared refactor" style already used throughout
 * scripts/ai/evaluation/*-schema.js: no schema-validation library, no
 * shared base class - plain JavaScript checks, a flat errors array, and a
 * { valid, errors } return shape identical to validateSampleV4()/
 * validateDatasetV4().
 *
 * Fields are intentionally restricted to the #15A design's minimal list
 * (id, category, sourceType, source, verifiedAt, tags, appliesTo,
 * statement, priority). Fields considered and rejected during #15A
 * (classification, confidence, reasoningGuidance, antiPatterns, scope,
 * title) are not present here and must not be added without repository
 * evidence proving one is technically necessary. Consistent with the
 * existing dataset/sample validators (see dataset-v4-schema.js), this
 * module does not reject unrecognized extra fields on a unit - none of
 * the existing schema modules in this repository enforce exhaustive
 * shape, only that the required fields are present and well-formed.
 *
 * Pure, synchronous, offline: no filesystem access, no environment
 * variables, no network.
 */

"use strict";

const CATEGORIES = ["PROJECT", "GENERAL_QA", "CROSS_BROWSER", "FRAMEWORK", "CI"];

const SOURCE_TYPES = ["PROJECT_VERIFIED", "CONTROLLED_EXPERIMENT", "CURATED_INTERNAL", "CURATED_EXTERNAL"];

// Only sourceType that requires a non-empty `source` reference (see
// Roadmap #15A's provenance model) - every other sourceType may leave
// `source` null.
const SOURCE_TYPE_REQUIRING_SOURCE = "CURATED_EXTERNAL";

const APPLIES_TO_LIST_FIELDS = ["browsers", "frameworks"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// Same "non-empty, every entry non-empty/non-whitespace, no duplicates"
// shape as dataset-v4-schema.js's own isUniqueNonEmptyStringArray - reused
// here (not imported) to keep this module's only dependency-free, matching
// the rest of this directory's "small duplicated primitives" convention.
function isUniqueNonEmptyStringArray(value) {
  if (!isStringArray(value) || value.length === 0) return false;
  if (!value.every((v) => v.trim().length > 0)) return false;
  return new Set(value).size === value.length;
}

// Strict YYYY-MM-DD check: the regex alone would accept a calendar-invalid
// date like "2026-02-30" (JavaScript's Date silently rolls that into
// March), so the parsed components are checked against what was actually
// supplied.
function isValidDateString(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function collectAppliesToErrors(appliesTo, errors, path) {
  if (!isPlainObject(appliesTo)) {
    errors.push(`${path}.appliesTo: must be an object`);
    return;
  }

  for (const field of APPLIES_TO_LIST_FIELDS) {
    const value = appliesTo[field];
    if (value === null) continue;
    if (!isUniqueNonEmptyStringArray(value)) {
      errors.push(`${path}.appliesTo.${field}: must be null or a non-empty array of unique, non-empty strings`);
    }
  }
}

function collectKnowledgeUnitErrors(unit, errors, pathPrefix) {
  const path = pathPrefix || "unit";

  if (!isPlainObject(unit)) {
    errors.push(`${path}: must be an object`);
    return;
  }

  if (!isNonEmptyString(unit.id)) {
    errors.push(`${path}.id: must be a non-empty string`);
  }

  if (!CATEGORIES.includes(unit.category)) {
    errors.push(`${path}.category: must be one of ${CATEGORIES.join(", ")}`);
  }

  const sourceType = unit.sourceType;
  if (!SOURCE_TYPES.includes(sourceType)) {
    errors.push(`${path}.sourceType: must be one of ${SOURCE_TYPES.join(", ")}`);
  }

  if (unit.source !== null && !isNonEmptyString(unit.source)) {
    errors.push(`${path}.source: must be null or a non-empty string`);
  }
  if (sourceType === SOURCE_TYPE_REQUIRING_SOURCE && !isNonEmptyString(unit.source)) {
    errors.push(`${path}.source: must be a non-empty string when sourceType is "${SOURCE_TYPE_REQUIRING_SOURCE}"`);
  }

  if (!isValidDateString(unit.verifiedAt)) {
    errors.push(`${path}.verifiedAt: must be a valid "YYYY-MM-DD" date string`);
  }

  if (!isUniqueNonEmptyStringArray(unit.tags)) {
    errors.push(`${path}.tags: must be a non-empty array of unique, non-empty strings`);
  }

  collectAppliesToErrors(unit.appliesTo, errors, path);

  if (!isNonEmptyString(unit.statement)) {
    errors.push(`${path}.statement: must be a non-empty string`);
  }

  if (!Number.isInteger(unit.priority)) {
    errors.push(`${path}.priority: must be an integer`);
  }
}

function validateKnowledgeUnit(unit) {
  const errors = [];
  collectKnowledgeUnitErrors(unit, errors, "unit");
  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateKnowledgeUnit,
  CATEGORIES,
  SOURCE_TYPES,
};
