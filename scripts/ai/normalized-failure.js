/**
 * Roadmap #19.5B - lightweight, dependency-free normalized failure
 * contract.
 *
 * This does NOT redesign context.failedTests[] and does NOT introduce a
 * new object model, class, or framework-adapter abstraction. It formalizes
 * the minimum generic shape the analysis core already depends on today
 * (see collect-context.js's extractFailedTests(), the only current
 * producer) as an explicit, checkable contract - so a future framework
 * collector/adapter (Roadmap #19.6+) has something concrete to be judged
 * against, rather than "whatever collect-context.js currently happens to
 * emit".
 *
 * Deliberately knows nothing about:
 *  - Mochawesome or any other raw report format;
 *  - Cypress artifact/screenshot naming conventions;
 *  - test-framework identity (see context.metadata.framework instead -
 *    framework identity is execution/context-level, never per-failure);
 *  - ProjectProfile, Knowledge, or History.
 *
 * Extra fields beyond this contract (e.g. collect-context.js's current
 * `suite`/`status`) are explicitly allowed, not rejected - this validates
 * only the minimum shape actually read downstream, following the same
 * "small dependency-free primitives" convention already used by
 * scripts/ai/knowledge/schema.js and scripts/ai/project-profile.js.
 */

"use strict";

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNullableFiniteNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

// Pure: never mutates `value`, never adds defaults, never strips fields -
// producer -> consumer data stays exactly as supplied either way.
function validateNormalizedFailure(value) {
  const errors = [];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["failure must be an object"] };
  }

  if (!isNullableString(value.title)) errors.push("title must be a string or null");
  if (!isNullableString(value.fullTitle)) errors.push("fullTitle must be a string or null");
  if (!isNullableString(value.specFile)) errors.push("specFile must be a string or null");

  if (!value.error || typeof value.error !== "object" || Array.isArray(value.error)) {
    errors.push("error must be an object");
  } else {
    if (!isNullableString(value.error.message)) errors.push("error.message must be a string or null");
    if (!isNullableString(value.error.stack)) errors.push("error.stack must be a string or null");
  }

  // Optional fields: only checked when actually present (an own property,
  // not merely `undefined` via bracket access) - absence is always valid.
  if (Object.prototype.hasOwnProperty.call(value, "duration") && !isNullableFiniteNumber(value.duration)) {
    errors.push("duration must be a finite number or null when present");
  }
  if (Object.prototype.hasOwnProperty.call(value, "screenshot") && !isNullableString(value.screenshot)) {
    errors.push("screenshot must be a string or null when present");
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateNormalizedFailure };
