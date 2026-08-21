"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isPathAllowed,
  resolveLocalImports,
  buildRelevantFiles,
  getMetadata,
  main,
} = require("./collect-context");
const { TARGOMO_PROJECT_PROFILE } = require("./project-profile");
const cypressAdapter = require("./adapters/cypress-adapter");
const { normalizeSpecPath } = require("./context-utils");

const ROOT = path.resolve(__dirname, "..", "..");

test("isPathAllowed: allows cypress/ files and the two named root files", () => {
  assert.equal(isPathAllowed(path.join(ROOT, "cypress", "e2e", "tests", "x.cy.js")), true);
  assert.equal(isPathAllowed(path.join(ROOT, "cypress.config.js")), true);
  assert.equal(isPathAllowed(path.join(ROOT, "package.json")), true);
});

test("isPathAllowed: denies anything outside the allowlist, even if it exists", () => {
  assert.equal(isPathAllowed(path.join(ROOT, "package-lock.json")), false);
  assert.equal(isPathAllowed(path.join(ROOT, ".git", "config")), false);
  assert.equal(isPathAllowed(path.join(ROOT, "..", "outside-repo.txt")), false);
});

test("isPathAllowed: denies secret-shaped filenames even under cypress/", () => {
  assert.equal(isPathAllowed(path.join(ROOT, "cypress", ".env")), false);
  assert.equal(isPathAllowed(path.join(ROOT, "cypress", "secrets.json")), false);
  assert.equal(isPathAllowed(path.join(ROOT, "cypress", "api.key")), false);
});

test("resolveLocalImports: resolves the real page objects a real spec file imports", () => {
  const specPath = path.join(ROOT, "cypress", "e2e", "tests", "category_tree_behavior.cy.js");
  const source = fs.readFileSync(specPath, "utf8");
  const resolved = resolveLocalImports(source, path.dirname(specPath));
  const relResolved = resolved.map((p) => normalizeSpecPath(p)).sort();

  assert.deepEqual(relResolved, [
    "cypress/e2e/pageObjects/categories.js",
    "cypress/e2e/pageObjects/navigation.js",
    "cypress/e2e/pageObjects/subCategories.js",
  ]);
});

test("resolveLocalImports: silently ignores an import that doesn't resolve to a real file", () => {
  const resolved = resolveLocalImports(`import { x } from '../pageObjects/doesNotExist.js';`, path.join(ROOT, "cypress", "e2e", "tests"));
  assert.deepEqual(resolved, []);
});

test("buildRelevantFiles: always includes cypress.config.js and package.json, plus the failed spec and its real imports, deduped", () => {
  const failedTests = [
    { specFile: "cypress/e2e/tests/category_tree_behavior.cy.js" },
    { specFile: "cypress/e2e/tests/poi_data_requests.cy.js" }, // imports the same navigation.js/categories.js
  ];
  const warnings = [];
  const files = buildRelevantFiles(failedTests, warnings);
  const keys = Object.keys(files);

  assert.ok(keys.includes("cypress.config.js"));
  assert.ok(keys.includes("package.json"));
  assert.ok(keys.includes("cypress/e2e/tests/category_tree_behavior.cy.js"));
  assert.ok(keys.includes("cypress/e2e/tests/poi_data_requests.cy.js"));
  assert.ok(keys.includes("cypress/e2e/pageObjects/navigation.js"));
  // shared import across both specs must appear exactly once
  assert.equal(keys.filter((k) => k === "cypress/e2e/pageObjects/navigation.js").length, 1);
});

test("buildRelevantFiles: warns instead of throwing when a failed spec no longer exists on disk", () => {
  const warnings = [];
  const files = buildRelevantFiles([{ specFile: "cypress/e2e/tests/does_not_exist.cy.js" }], warnings);
  assert.ok(!("cypress/e2e/tests/does_not_exist.cy.js" in files));
  assert.ok(warnings.some((w) => w.includes("not found on disk")));
});

test("getMetadata: TEST_BROWSER takes priority over BROWSER/CYPRESS_BROWSER", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.TEST_BROWSER = "firefox";
  process.env.BROWSER = "chrome";
  process.env.CI = "true";

  const meta = getMetadata();
  assert.equal(meta.browser, "firefox");
  assert.equal(meta.ci, true);
});

test("getMetadata: projectId is the stable production project identity (Roadmap #19.2)", () => {
  assert.equal(getMetadata().projectId, "external-poi-sut");
  assert.equal(getMetadata().projectId, TARGOMO_PROJECT_PROFILE.id);
});

// Roadmap #19.6B: framework is now sourced from the Cypress adapter's own
// identity (cypressAdapter.id), not a second, separately-hardcoded
// constant in this file - see getMetadata() itself. The production value
// this asserts is unchanged.
test("getMetadata: framework is unconditionally the current adapter's stable identity 'cypress' (Roadmap #19.5B/#19.6B)", () => {
  assert.equal(getMetadata().framework, "cypress");
  assert.equal(getMetadata().framework, cypressAdapter.id);
});

test("getMetadata: framework is present even with no relevant environment variables set", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  for (const key of ["GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_HEAD_REF", "GITHUB_REF_NAME", "GITHUB_RUN_ID", "GITHUB_EVENT_NAME", "TEST_BROWSER", "BROWSER", "CYPRESS_BROWSER", "CI"]) {
    delete process.env[key];
  }
  assert.equal(getMetadata().framework, "cypress");
});

// Roadmap #19.2: collect-context.js no longer defines its own
// KNOWN_PROJECT_CONSTRAINTS array - project facts are now owned by
// scripts/ai/project-profile.js (see project-profile.test.js for
// that module's own shape/content tests) and only consumed here. This
// test proves the ownership transfer: collect-context.js's own module
// exports contain no such array, so there is no duplicate, drifting copy
// of project-constraint text anywhere in this file.
test("collect-context.js no longer exports its own KNOWN_PROJECT_CONSTRAINTS (ownership moved to ProjectProfile, Roadmap #19.2)", () => {
  const exportsFromModule = require("./collect-context");
  assert.equal("KNOWN_PROJECT_CONSTRAINTS" in exportsFromModule, false);
});

// --- Roadmap #19.6B: generic orchestration wiring proof -----------------
// Proves main() actually incorporates the real cypressAdapter.collect()
// result (testResults/failedTests/warnings) and cypressAdapter.id (for
// metadata.framework) into the written context.json, using a controlled
// real-artifact fixture rather than invasive dependency-injection/module-
// cache mocking (see Roadmap #19.6A's Phase 28 recommendation).
test("main(): writes context.json whose testResults/failedTests/warnings/metadata.framework come from the real Cypress adapter", (t) => {
  const reportsDir = path.join(ROOT, "reports", "cypress");
  const outputFile = path.join(ROOT, "reports", "ai", "context.json");
  fs.rmSync(path.join(ROOT, "reports"), { recursive: true, force: true });
  t.after(() => fs.rmSync(path.join(ROOT, "reports"), { recursive: true, force: true }));

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportsDir, "report.json"),
    JSON.stringify({
      stats: { tests: 1, passes: 0, failures: 1, pending: 0, duration: 7 },
      results: [
        {
          file: "cypress/e2e/tests/category_tree_behavior.cy.js",
          suites: [
            { title: "Suite", suites: [], tests: [{ title: "orchestration fixture failure", state: "failed", duration: 7, err: { message: "m", estack: "s" } }] },
          ],
        },
      ],
    })
  );

  main();

  const written = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(written.metadata.framework, cypressAdapter.id);
  assert.equal(written.metadata.framework, "cypress");
  assert.equal(written.testResults.found, true);
  assert.equal(written.testResults.totals.failed, 1);
  assert.equal(written.failedTests.length, 1);
  assert.equal(written.failedTests[0].title, "orchestration fixture failure");
  assert.deepEqual(written.warnings, []);
});
