/**
 * ProjectProfile - stable, data-only project identity and project-specific
 * context (Roadmap #19.2).
 *
 * A ProjectProfile owns exactly two things: a stable machine-readable
 * project identity (`id`, `displayName`) and stable project-specific
 * background facts (`knownProjectConstraints`). It owns nothing else -
 * no framework identity, no current-run evidence, no classification, no
 * policy, no knowledge selection, no history reasoning, no provider
 * configuration/secrets, no browser-correlation semantics, no artifact
 * parsing, no callbacks, no dynamic code. See scripts/ai/agent-policy.js,
 * scripts/ai/providers/, scripts/ai/knowledge/, and
 * scripts/ai/aggregate-browser-context.js for those - none of them are
 * touched by this module.
 *
 * GUIDANCE, NEVER EVIDENCE: a knownProjectConstraints entry is a stable
 * background fact about the project (e.g. "the SUT is an external live
 * service this repo doesn't control"), not proof that this fact caused
 * any specific current-run failure - the same authority boundary already
 * enforced for this same content by qa-agent-prompt.js's rule 9.
 *
 * There is exactly one real production project today. This module
 * reflects that reality directly - a single exported profile constant,
 * not a registry, factory, or plugin system. A second project (Roadmap
 * #19.4) is expected to be introduced as another plain object of the same
 * shape, supplied as data to the functions that accept a profile
 * parameter (see qa-agent-prompt.js's buildSystemPrompt()) - never by
 * editing this file's consumers.
 */

"use strict";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

// Lightweight, dependency-free shape check - deliberately not a shared
// schema library, matching the "small duplicated primitives" convention
// already used by scripts/ai/knowledge/schema.js and
// scripts/ai/evaluation/*-schema.js rather than introducing a new one.
function validateProjectProfile(profile) {
  const errors = [];

  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { valid: false, errors: ["profile must be an object"] };
  }
  if (!isNonEmptyString(profile.id)) {
    errors.push("id must be a non-empty string");
  }
  if (!isNonEmptyString(profile.displayName)) {
    errors.push("displayName must be a non-empty string");
  }
  if (!isNonEmptyStringArray(profile.knownProjectConstraints)) {
    errors.push("knownProjectConstraints must be a non-empty array of non-empty strings");
  }

  return { valid: errors.length === 0, errors };
}

// The single production project. `id` is the canonical, stable,
// machine-readable project identity referenced elsewhere as
// "external-poi-sut" (context.metadata.projectId, ai-report.json's
// sourceContext.projectId) - this object is the only place that literal
// is defined; everything else imports it from here. `id` identifies the
// logical external POI SUT project itself, not any single point-in-time
// attribute of it - it is not a hostname, a vendor/brand name, or a test
// framework, and should not be renamed merely because `displayName`,
// `baseUrl`, the external vendor, or the test framework changes.
//
// `displayName` fills the exact clause the system prompt's persona
// sentence previously hardcoded (see qa-agent-prompt.js) - kept
// byte-identical in wording so the production prompt's meaning is
// unchanged, only its origin moved.
//
// `knownProjectConstraints` is moved here verbatim from
// collect-context.js's former KNOWN_PROJECT_CONSTRAINTS array - same
// text, same order, no rewrite.
const TARGOMO_PROJECT_PROFILE = Object.freeze({
  id: "external-poi-sut",
  displayName: "a live, externally hosted third-party application (poi.targomo.com)",
  // Frozen (see below) - collect-context.js assigns this exact array
  // reference into context.knownProjectConstraints (no defensive copy),
  // so without freezing, a future consumer mutating "its own" context
  // data (e.g. context.knownProjectConstraints.push(...) - the same
  // in-place-mutation style buildFailureReport() already uses for
  // context.history/context.relevantKnowledge) would silently corrupt
  // this shared, singleton, process-lifetime constant for every
  // subsequent analysis, and - in the long-lived `node --test` process -
  // every later test.
  knownProjectConstraints: Object.freeze([
    "Firefox runs in this CI workflow (Roadmap #14C) in a different execution environment from Chrome/Edge: Chrome and Edge run inside a cypress/included Docker container, while Firefox runs directly on the bare GitHub Actions runner with Firefox installed explicitly. This split exists because Firefox previously hung during WebDriver session creation when run inside that same nested container - an infrastructure/sandboxing limitation of that specific setup, not evidence of a browser-specific product bug or test defect.",
    "The application under test (poi.targomo.com) is a live, externally hosted third-party service outside this repository's control - it has no staging/mocked environment, so failures can reflect real upstream instability, not just this repo's code.",
  ]),
});

module.exports = { TARGOMO_PROJECT_PROFILE, validateProjectProfile };
