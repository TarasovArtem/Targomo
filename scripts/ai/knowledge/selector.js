/**
 * Deterministic, offline selector for QA Knowledge units.
 *
 * selectKnowledge(context, units, options) picks which of the already-
 * loaded knowledge units (see loader.js) are relevant to a given failure
 * context, using ONLY signals available BEFORE the AI provider is ever
 * called - the same context.json shape aggregate-browser-context.js
 * produces and qa-agent-prompt.js's buildUserPrompt() already reads
 * (metadata, failedTests, relevantFiles, knownProjectConstraints,
 * browserCorrelation). Deliberately excluded: classification, rootCause,
 * evidence, recommendedFix, confidence, or any other model-generated
 * output - none of that exists yet at selection time, and using it would
 * silently require a second AI phase (see Roadmap #15A Phase 10/#15B.2
 * Phase 7).
 *
 * Pure with respect to selection logic: no filesystem access, no network,
 * no provider of any kind, no randomness, no wall-clock dependency. Given
 * the same context and the same units array, selectKnowledge() always
 * returns the same result.
 *
 * This module is NOT wired into production. qa-agent-prompt.js,
 * analyze-failure.js, and context.json/ai-report.json's shapes are
 * untouched - see Roadmap #16 for that future step.
 */

"use strict";

// Every unit's category/appliesTo/sourceType/tags matter for eligibility
// and ranking, but only `id` and `statement` are surfaced in the return
// shape (Phase 14) - the rest stays internal selection machinery.

const DEFAULT_MAX_UNITS = 5;
const DEFAULT_MAX_CHARS = 2000;

// Legacy compatibility fallback only (Roadmap #19.5B) - used when NEITHER
// the canonical context.metadata.framework NOR the legacy context.frameworks
// array is usable. This repository's own historically Cypress-only nature
// is the reason this constant is "cypress", not a guess: every context this
// fallback still applies to predates explicit framework identity entirely.
const DEFAULT_FRAMEWORKS = ["cypress"];

function normalize(text) {
  return typeof text === "string" ? text.toLowerCase().trim().replace(/\s+/g, " ") : "";
}

// Every browser this failure context actually concerns: when
// browserCorrelation is present (the real production aggregator path),
// that's every browser that failed in this run (primaryBrowser is always
// included in failedBrowsers - see aggregate-browser-context.js); when
// it's absent (e.g. a local/non-aggregated run), fall back to
// metadata.browser alone. Never guessed beyond what the context actually
// states.
function getRelevantBrowsers(context) {
  const correlation = context && context.browserCorrelation;
  if (correlation && Array.isArray(correlation.failedBrowsers) && correlation.failedBrowsers.length > 0) {
    return correlation.failedBrowsers;
  }
  const metaBrowser = context && context.metadata && context.metadata.browser;
  return metaBrowser ? [metaBrowser] : [];
}

// Roadmap #19.5B: classifies context.metadata.framework's presence/
// well-formedness the same way #19.3C's classifyProjectId() already does
// for project identity - a property that was never set at all (ABSENT) is
// a fundamentally different, more permissive signal than one that IS set
// but broken (INVALID, e.g. null/""/whitespace/non-string): only ABSENT
// may fall back to legacy context.frameworks / DEFAULT_FRAMEWORKS: an
// explicitly-set-but-malformed value must never be silently reinterpreted
// as "no opinion". Local to this module (not shared with
// analyze-failure.js's classifyProjectId()) since each classifies a
// different field for a different gate, following this repository's
// existing "small duplicated primitives, not a shared refactor"
// convention (see knowledge/schema.js's own module comment).
function classifyFrameworkId(metadata) {
  const hasProperty = Boolean(metadata) && Object.prototype.hasOwnProperty.call(metadata, "framework");
  if (!hasProperty) return { state: "ABSENT", value: null };

  const raw = metadata.framework;
  if (typeof raw !== "string" || raw.trim().length === 0) return { state: "INVALID", value: null };

  return { state: "VALID", value: raw.trim().toLowerCase() };
}

// Roadmap #19.5B precedence: a VALID canonical context.metadata.framework
// is authoritative and used alone - it is never unioned with legacy
// context.frameworks. Only when the canonical field is genuinely ABSENT
// does the pre-#19.5B legacy behavior apply unchanged (explicit
// context.frameworks array, else DEFAULT_FRAMEWORKS). An INVALID
// (present-but-malformed) canonical value returns [] - fail-closed for
// every framework-scoped unit (intersects() with an empty set is always
// false) while leaving framework-orthogonal (appliesTo.frameworks: null)
// units completely unaffected, since isEligible() only consults
// relevantFrameworks when the UNIT itself declares a non-null scope. This
// mirrors exactly how a missing/invalid currentProjectId already
// fail-closes project-scoped Knowledge above, without needing any change
// to isEligible() itself.
function getRelevantFrameworks(context) {
  const classified = classifyFrameworkId(context && context.metadata);

  if (classified.state === "VALID") return [classified.value];
  if (classified.state === "INVALID") return [];

  // ABSENT - unchanged pre-#19.5B legacy behavior.
  return context && Array.isArray(context.frameworks) ? context.frameworks : DEFAULT_FRAMEWORKS;
}

// The current analysis's stable project identity (Roadmap #19.2's
// ProjectProfile.id, carried through as context.metadata.projectId) -
// read directly off context, never imported from project-profile.js and
// never defaulted to this repository's production id: this module stays
// project-neutral, exactly like it is already framework-neutral (no
// project literal appears anywhere in this file). A missing, non-string,
// or whitespace-only value returns null ("no known current project"),
// the same fail-closed signal a genuinely absent field would produce -
// it is never guessed from browser, framework, hostname, or repository.
function getRelevantProjectId(context) {
  const projectId = context && context.metadata && context.metadata.projectId;
  return typeof projectId === "string" && projectId.trim().length > 0 ? projectId : null;
}

// Deterministic, fixed-order concatenation of every pre-call signal this
// selector is allowed to use (see Phase 7/8). Ordering is fixed by this
// function's own source, not by object/array enumeration of anything
// externally controlled - failedTests/relevantFiles are walked in their
// existing array/insertion order (already deterministic - failedTests is
// an ordered array from collect-context.js, and relevantFiles' keys come
// from that same deterministic build), never re-sorted by this function.
//
// Deliberately excludes stack traces: they are long, already truncated
// elsewhere (see collect-context.js's MAX_STACK_CHARS), and mixing large,
// noisy stack text into the matching signal would risk incidental
// substring collisions unrelated to genuine tag relevance. The error
// *message* (never truncated upstream) plus titles/paths/metadata is a
// materially cleaner signal for small, explainable keyword matching.
function buildSignalText(context) {
  const parts = [];

  parts.push(...getRelevantFrameworks(context));

  const failedTests = (context && context.failedTests) || [];
  for (const t of failedTests) {
    if (t.error && t.error.message) parts.push(t.error.message);
    if (t.title) parts.push(t.title);
    if (t.fullTitle) parts.push(t.fullTitle);
    if (t.specFile) parts.push(t.specFile);
  }

  const relevantFiles = (context && context.relevantFiles) || {};
  parts.push(...Object.keys(relevantFiles));

  const correlation = context && context.browserCorrelation;
  if (correlation) {
    parts.push(...(correlation.browsers || []));
    parts.push(...(correlation.failedBrowsers || []));
    if (correlation.primaryBrowser) parts.push(correlation.primaryBrowser);
    if (correlation.failureScope) parts.push(correlation.failureScope);
    // Encoded as "key=value" (no space) so a tag like "sameFailureSignature"
    // still matches as a plain substring of "samefailuresignature=true".
    parts.push(`sameFailureSignature=${correlation.sameFailureSignature}`);
    if (correlation.failureScope === "multi-browser") parts.push("cross-browser");
  }

  parts.push(...((context && context.knownProjectConstraints) || []));

  const metaBrowser = context && context.metadata && context.metadata.browser;
  if (metaBrowser) parts.push(metaBrowser);

  return normalize(parts.join(" "));
}

function intersects(a, b) {
  const set = new Set(b);
  return a.some((v) => set.has(v));
}

// Structural gate (Phase 10, extended by Roadmap #19.3B): appliesTo.
// browsers/frameworks/projects scope eligibility, they never contribute
// to ranking. A null field imposes no restriction; a non-null field
// requires the current context to actually satisfy it - the current
// context must satisfy the unit's own scoping, never the other way
// around (see Phase 16.C).
//
// Project scoping (appliesTo.projects) is a single-value membership
// check, not a set intersection like browsers/frameworks: a unit belongs
// to one or more named projects, and the CURRENT analysis has at most one
// current project, so eligibility is "is the current project one of the
// unit's projects", not "do two sets overlap". A unit with a non-null
// appliesTo.projects is excluded whenever the current project is unknown
// (currentProjectId === null) - fail-closed, so a missing projectId can
// never make project-specific knowledge appear global. A null
// appliesTo.projects is unaffected either way (project-orthogonal).
function isEligible(unit, relevantBrowsers, relevantFrameworks, currentProjectId) {
  const appliesTo = unit.appliesTo || {};
  if (Array.isArray(appliesTo.projects) && (!currentProjectId || !appliesTo.projects.includes(currentProjectId))) {
    return false;
  }
  if (Array.isArray(appliesTo.browsers) && !intersects(appliesTo.browsers, relevantBrowsers)) return false;
  if (Array.isArray(appliesTo.frameworks) && !intersects(appliesTo.frameworks, relevantFrameworks)) return false;
  return true;
}

// Case-insensitive substring count: how many of this unit's own tags
// appear anywhere in the normalized signal text. This is the only
// relevance signal - eligibility (appliesTo) merely gates candidacy, it
// never substitutes for an actual keyword match (see Phase 16.B: a
// structurally-eligible but topically-irrelevant unit must still score 0
// and be excluded).
function computeMatchScore(unit, signalText) {
  const tags = unit.tags || [];
  let score = 0;
  for (const tag of tags) {
    if (signalText.includes(normalize(tag))) score += 1;
  }
  return score;
}

// Fully deterministic: (score DESC, priority DESC, id ASC). Never depends
// on filesystem enumeration, JSON insertion/array order, randomness, or
// wall-clock time - the same candidate set always sorts identically.
function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.unit.priority !== a.unit.priority) return b.unit.priority - a.unit.priority;
  return a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0;
}

// Selects which of `units` (already loaded/validated by loader.js) are
// relevant to `context`, respecting a hard unit-count and character
// budget. Returns [] when nothing matches - a normal, expected outcome
// (Phase 12), never an error.
//
// Budget policy (Phase 13): candidates are walked in final ranked order;
// a candidate whose statement would push the running character total over
// maxChars is skipped (never included, never truncated), but later,
// possibly-smaller candidates are still considered - so one large,
// top-ranked statement can never block a smaller, still-relevant one from
// being included. Selection still stops immediately once maxUnits
// selected units have been accepted.
function selectKnowledge(context, units, options = {}) {
  const maxUnits = Number.isInteger(options.maxUnits) ? options.maxUnits : DEFAULT_MAX_UNITS;
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;

  const relevantBrowsers = getRelevantBrowsers(context);
  const relevantFrameworks = getRelevantFrameworks(context);
  const currentProjectId = getRelevantProjectId(context);
  const signalText = buildSignalText(context);

  const candidates = (units || [])
    .filter((unit) => isEligible(unit, relevantBrowsers, relevantFrameworks, currentProjectId))
    .map((unit) => ({ unit, score: computeMatchScore(unit, signalText) }))
    .filter((candidate) => candidate.score > 0)
    .sort(compareCandidates);

  const selected = [];
  let totalChars = 0;

  for (const candidate of candidates) {
    if (selected.length >= maxUnits) break;

    const statement = candidate.unit.statement;
    if (totalChars + statement.length > maxChars) continue;

    selected.push({ id: candidate.unit.id, statement });
    totalChars += statement.length;
  }

  return selected;
}

module.exports = {
  selectKnowledge,
  buildSignalText,
  getRelevantBrowsers,
  getRelevantFrameworks,
  getRelevantProjectId,
  classifyFrameworkId,
  DEFAULT_MAX_UNITS,
  DEFAULT_MAX_CHARS,
};
