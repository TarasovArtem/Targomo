"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { normalizeSpecPath } = require("./context-utils");

const ROOT = path.resolve(__dirname, "..", "..");

test("normalizeSpecPath: strips the repo root and leading slashes, normalizes backslashes", () => {
  assert.equal(
    normalizeSpecPath(path.join(ROOT, "cypress", "e2e", "tests", "x.cy.js")),
    "cypress/e2e/tests/x.cy.js"
  );
  assert.equal(normalizeSpecPath("\\cypress\\e2e\\tests\\x.cy.js"), "cypress/e2e/tests/x.cy.js");
  assert.equal(normalizeSpecPath(null), null);
  assert.equal(normalizeSpecPath(""), null);
});
