"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateKnowledgeUnit, CATEGORIES, SOURCE_TYPES } = require("./schema");

function makeValidUnit(overrides = {}) {
  const base = {
    id: "qa-selector-timeout-vs-flaky",
    category: "GENERAL_QA",
    sourceType: "CURATED_INTERNAL",
    source: null,
    verifiedAt: "2026-08-18",
    tags: ["timed out retrying", "cy.get", "timeout"],
    appliesTo: { browsers: null, frameworks: ["cypress"] },
    statement: "A 'Timed out retrying' error can indicate a synchronization gap rather than a broken selector.",
    priority: 5,
  };
  return { ...base, ...overrides };
}

// --- valid units for every sourceType -------------------------------------

test("valid PROJECT_VERIFIED unit passes", () => {
  const unit = makeValidUnit({
    id: "project-firefox-execution-environment-split",
    category: "PROJECT",
    sourceType: "PROJECT_VERIFIED",
    source: null,
  });
  const result = validateKnowledgeUnit(unit);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("valid CURATED_INTERNAL unit passes", () => {
  const unit = makeValidUnit({ sourceType: "CURATED_INTERNAL", source: null });
  const result = validateKnowledgeUnit(unit);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("valid CONTROLLED_EXPERIMENT unit passes", () => {
  const unit = makeValidUnit({
    id: "cross-browser-differing-signature-caution",
    category: "CROSS_BROWSER",
    sourceType: "CONTROLLED_EXPERIMENT",
    source: null,
  });
  const result = validateKnowledgeUnit(unit);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("valid CURATED_EXTERNAL unit with a non-empty source passes", () => {
  const unit = makeValidUnit({
    sourceType: "CURATED_EXTERNAL",
    source: "https://docs.cypress.io/guides/core-concepts/retry-ability",
  });
  const result = validateKnowledgeUnit(unit);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

// --- source / sourceType coupling -----------------------------------------

test("CURATED_EXTERNAL without a source is rejected", () => {
  const unit = makeValidUnit({ sourceType: "CURATED_EXTERNAL", source: null });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("source")));
});

test("CURATED_EXTERNAL with an empty-string source is rejected", () => {
  const unit = makeValidUnit({ sourceType: "CURATED_EXTERNAL", source: "   " });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("source")));
});

test("a non-external unit may leave source null", () => {
  const unit = makeValidUnit({ sourceType: "CURATED_INTERNAL", source: null });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, true);
});

test("source must be null or a string, not another type", () => {
  const unit = makeValidUnit({ source: 12345 });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("source")));
});

// --- category / sourceType enums -------------------------------------------

test("unknown category is rejected", () => {
  const unit = makeValidUnit({ category: "NOT_A_REAL_CATEGORY" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("category")));
});

test("unknown sourceType is rejected", () => {
  const unit = makeValidUnit({ sourceType: "MADE_UP_SOURCE" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("sourceType")));
});

test("CATEGORIES exposes exactly the five #15A-approved categories", () => {
  assert.deepEqual(CATEGORIES, ["PROJECT", "GENERAL_QA", "CROSS_BROWSER", "FRAMEWORK", "CI"]);
});

test("SOURCE_TYPES exposes exactly the four #15A-approved provenance types", () => {
  assert.deepEqual(SOURCE_TYPES, [
    "PROJECT_VERIFIED",
    "CONTROLLED_EXPERIMENT",
    "CURATED_INTERNAL",
    "CURATED_EXTERNAL",
  ]);
});

// --- id / statement ----------------------------------------------------

test("missing id is rejected", () => {
  const unit = makeValidUnit();
  delete unit.id;
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes(".id")));
});

test("empty-string id is rejected", () => {
  const unit = makeValidUnit({ id: "" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes(".id")));
});

test("empty statement is rejected", () => {
  const unit = makeValidUnit({ statement: "" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("statement")));
});

test("whitespace-only statement is rejected", () => {
  const unit = makeValidUnit({ statement: "   \n\t  " });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("statement")));
});

// --- verifiedAt ----------------------------------------------------------

test("invalid verifiedAt format is rejected", () => {
  const unit = makeValidUnit({ verifiedAt: "08/18/2026" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("verifiedAt")));
});

test("calendar-invalid verifiedAt (e.g. Feb 30) is rejected", () => {
  const unit = makeValidUnit({ verifiedAt: "2026-02-30" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("verifiedAt")));
});

test("non-string verifiedAt is rejected", () => {
  const unit = makeValidUnit({ verifiedAt: 20260818 });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("verifiedAt")));
});

// --- tags ------------------------------------------------------------------

test("missing tags is rejected", () => {
  const unit = makeValidUnit();
  delete unit.tags;
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("tags")));
});

test("empty tags array is rejected", () => {
  const unit = makeValidUnit({ tags: [] });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("tags")));
});

test("tags containing a whitespace-only entry is rejected", () => {
  const unit = makeValidUnit({ tags: ["real-tag", "   "] });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("tags")));
});

test("duplicate tags are rejected", () => {
  const unit = makeValidUnit({ tags: ["timeout", "timeout"] });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("tags")));
});

// --- appliesTo ---------------------------------------------------------

test("malformed appliesTo (not an object) is rejected", () => {
  const unit = makeValidUnit({ appliesTo: "cypress" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("appliesTo")));
});

test("appliesTo with both fields null is valid (no scoping restriction)", () => {
  const unit = makeValidUnit({ appliesTo: { browsers: null, frameworks: null } });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, true);
});

test("appliesTo.browsers as a non-empty unique array is valid", () => {
  const unit = makeValidUnit({ appliesTo: { browsers: ["firefox"], frameworks: null } });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, true);
});

test("duplicate browser entries in appliesTo.browsers are rejected", () => {
  const unit = makeValidUnit({ appliesTo: { browsers: ["chrome", "chrome"], frameworks: null } });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("appliesTo.browsers")));
});

test("duplicate framework entries in appliesTo.frameworks are rejected", () => {
  const unit = makeValidUnit({ appliesTo: { browsers: null, frameworks: ["cypress", "cypress"] } });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("appliesTo.frameworks")));
});

test("empty array for appliesTo.browsers is rejected (use null instead)", () => {
  const unit = makeValidUnit({ appliesTo: { browsers: [], frameworks: null } });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("appliesTo.browsers")));
});

test("non-string entries in appliesTo.frameworks are rejected", () => {
  const unit = makeValidUnit({ appliesTo: { browsers: null, frameworks: [123] } });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("appliesTo.frameworks")));
});

// --- priority ----------------------------------------------------------

test("non-integer priority is rejected", () => {
  const unit = makeValidUnit({ priority: 5.5 });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("priority")));
});

test("string priority is rejected", () => {
  const unit = makeValidUnit({ priority: "5" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("priority")));
});

test("negative integer priority is valid (sign is not restricted)", () => {
  const unit = makeValidUnit({ priority: -1 });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, true);
});

// --- unrecognized fields -------------------------------------------------
//
// Consistent with every existing schema module in this repository (see
// dataset-v4-schema.js's collectSampleErrorsV4, which never rejects a
// sample for carrying an extra key), this validator only checks that the
// required fields are present and well-formed - it does not enforce
// exhaustive shape. In particular, a field like "classification" that was
// explicitly rejected from the #15A schema design does not make a unit
// invalid by merely being present alongside the real, valid fields; the
// guarantee this repository actually needs - keeping the enum authoritative
// and the required fields intact - is enforced above.
test("an extra, unrecognized field does not affect validity (matches existing repo schema convention)", () => {
  const unit = makeValidUnit({ classification: "TEST_BUG", extraneousField: "anything" });
  const result = validateKnowledgeUnit(unit);
  assert.equal(result.valid, true);
});

// --- non-object input ----------------------------------------------------

test("null unit is rejected", () => {
  const result = validateKnowledgeUnit(null);
  assert.equal(result.valid, false);
});

test("array unit is rejected", () => {
  const result = validateKnowledgeUnit([]);
  assert.equal(result.valid, false);
});

test("string unit is rejected", () => {
  const result = validateKnowledgeUnit("not-a-unit");
  assert.equal(result.valid, false);
});

// --- determinism -----------------------------------------------------------

test("validateKnowledgeUnit is deterministic for the same input", () => {
  const unit = makeValidUnit();
  const first = validateKnowledgeUnit(unit);
  const second = validateKnowledgeUnit(unit);
  assert.deepEqual(first, second);
});
