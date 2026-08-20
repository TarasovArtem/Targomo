"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TARGOMO_PROJECT_PROFILE, validateProjectProfile } = require("./project-profile");

test("TARGOMO_PROJECT_PROFILE: id is the stable production project identity", () => {
  assert.equal(TARGOMO_PROJECT_PROFILE.id, "external-poi-sut");
});

test("TARGOMO_PROJECT_PROFILE: displayName is a non-empty string mentioning poi.targomo.com", () => {
  assert.equal(typeof TARGOMO_PROJECT_PROFILE.displayName, "string");
  assert.ok(TARGOMO_PROJECT_PROFILE.displayName.length > 0);
  assert.match(TARGOMO_PROJECT_PROFILE.displayName, /poi\.targomo\.com/);
});

test("TARGOMO_PROJECT_PROFILE: knownProjectConstraints is a non-empty array of plain strings (no secrets/tokens)", () => {
  assert.ok(Array.isArray(TARGOMO_PROJECT_PROFILE.knownProjectConstraints));
  assert.ok(TARGOMO_PROJECT_PROFILE.knownProjectConstraints.length > 0);
  TARGOMO_PROJECT_PROFILE.knownProjectConstraints.forEach((entry) => assert.equal(typeof entry, "string"));
});

test("TARGOMO_PROJECT_PROFILE: known constraint order/text is preserved - Firefox execution-environment fact first, external-service fact second", () => {
  assert.match(TARGOMO_PROJECT_PROFILE.knownProjectConstraints[0], /Firefox runs in this CI workflow/);
  assert.match(TARGOMO_PROJECT_PROFILE.knownProjectConstraints[1], /poi\.targomo\.com.*live, externally hosted third-party service/);
});

test("TARGOMO_PROJECT_PROFILE: has exactly the #19.2 contract's three keys (id, displayName, knownProjectConstraints) - update this alongside any deliberate future field addition (e.g. #19.3 knowledge/history scoping fields), not as a permanent architecture ceiling", () => {
  const keys = Object.keys(TARGOMO_PROJECT_PROFILE);
  assert.deepEqual(keys.sort(), ["displayName", "id", "knownProjectConstraints"]);
});

test("TARGOMO_PROJECT_PROFILE: exposes no secrets, provider config, or network/dynamic behavior", () => {
  for (const value of Object.values(TARGOMO_PROJECT_PROFILE)) {
    assert.notEqual(typeof value, "function");
  }
});

// collect-context.js assigns TARGOMO_PROJECT_PROFILE.knownProjectConstraints
// straight into context.knownProjectConstraints, the same array reference,
// no defensive copy - so this constant must be immutable, or a future
// context-mutating consumer could silently corrupt shared production
// guidance (and, in the long-lived `node --test` process, every later
// test that reads this same singleton).
test("TARGOMO_PROJECT_PROFILE: is frozen and cannot be mutated", () => {
  assert.equal(Object.isFrozen(TARGOMO_PROJECT_PROFILE), true);
  assert.throws(() => {
    "use strict";
    TARGOMO_PROJECT_PROFILE.id = "something-else";
  }, TypeError);
});

test("TARGOMO_PROJECT_PROFILE.knownProjectConstraints: the array itself is frozen and cannot be mutated", () => {
  assert.equal(Object.isFrozen(TARGOMO_PROJECT_PROFILE.knownProjectConstraints), true);
  assert.throws(() => {
    "use strict";
    TARGOMO_PROJECT_PROFILE.knownProjectConstraints.push("a new constraint");
  }, TypeError);
});

test("validateProjectProfile: accepts the production Targomo profile", () => {
  const { valid, errors } = validateProjectProfile(TARGOMO_PROJECT_PROFILE);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("validateProjectProfile: accepts a well-formed synthetic profile shaped like a future second project", () => {
  const { valid, errors } = validateProjectProfile({
    id: "synthetic-project",
    displayName: "Synthetic Application",
    knownProjectConstraints: ["Synthetic project constraint."],
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("validateProjectProfile: rejects a missing id", () => {
  const { valid, errors } = validateProjectProfile({
    displayName: "Synthetic Application",
    knownProjectConstraints: ["Synthetic project constraint."],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("id")));
});

test("validateProjectProfile: rejects an empty-string displayName", () => {
  const { valid, errors } = validateProjectProfile({
    id: "synthetic-project",
    displayName: "   ",
    knownProjectConstraints: ["Synthetic project constraint."],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("displayName")));
});

test("validateProjectProfile: rejects an empty knownProjectConstraints array", () => {
  const { valid, errors } = validateProjectProfile({
    id: "synthetic-project",
    displayName: "Synthetic Application",
    knownProjectConstraints: [],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("knownProjectConstraints")));
});

test("validateProjectProfile: rejects a non-string entry inside knownProjectConstraints", () => {
  const { valid, errors } = validateProjectProfile({
    id: "synthetic-project",
    displayName: "Synthetic Application",
    knownProjectConstraints: ["fine", 42],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("knownProjectConstraints")));
});

test("validateProjectProfile: rejects null/non-object input without throwing", () => {
  assert.equal(validateProjectProfile(null).valid, false);
  assert.equal(validateProjectProfile(undefined).valid, false);
  assert.equal(validateProjectProfile("external-poi-sut").valid, false);
  assert.equal(validateProjectProfile([]).valid, false);
});
