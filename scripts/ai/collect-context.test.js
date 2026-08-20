"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeSpecPath,
  isPathAllowed,
  extractFailedTests,
  summarizeTestResults,
  resolveLocalImports,
  resolveScreenshotPath,
  loadReports,
  buildRelevantFiles,
  getMetadata,
  truncateText,
} = require("./collect-context");
const { TARGOMO_PROJECT_PROFILE } = require("./project-profile");

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

test("extractFailedTests: walks nested suites and collects only failed tests", () => {
  const reports = [
    {
      results: [
        {
          file: "/cypress/e2e/tests/x.cy.js",
          suites: [
            {
              title: "Outer",
              suites: [
                {
                  title: "Inner",
                  suites: [],
                  tests: [
                    { title: "passes", state: "passed" },
                    {
                      title: "fails",
                      state: "failed",
                      duration: 42,
                      err: { message: "boom", estack: "boom\n  at x" },
                    },
                  ],
                },
              ],
              tests: [],
            },
          ],
        },
      ],
    },
  ];

  const failed = extractFailedTests(reports);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].title, "fails");
  assert.equal(failed[0].suite, "Outer > Inner");
  assert.equal(failed[0].specFile, "cypress/e2e/tests/x.cy.js");
  assert.equal(failed[0].duration, 42);
  assert.equal(failed[0].error.message, "boom");
  assert.equal(failed[0].error.stack, "boom\n  at x");
});

test("summarizeTestResults: aggregates totals across multiple spec reports", () => {
  const reports = [
    { stats: { tests: 3, passes: 2, failures: 1, pending: 0, duration: 100 }, results: [{ file: "/a.cy.js", suites: [] }] },
    { stats: { tests: 2, passes: 2, failures: 0, pending: 0, duration: 50 }, results: [{ file: "/b.cy.js", suites: [] }] },
  ];
  const summary = summarizeTestResults(reports);
  assert.equal(summary.found, true);
  assert.deepEqual(summary.totals, { tests: 5, passed: 4, failed: 1, pending: 0, duration: 150 });
  assert.equal(summary.specs.length, 2);
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

test("resolveScreenshotPath: matches only the exact '(failed)' filename, never a same-prefix guess", (t) => {
  const specDir = path.join(ROOT, "cypress", "screenshots", "fixture.cy.js");
  fs.mkdirSync(specDir, { recursive: true });
  t.after(() => fs.rmSync(path.join(ROOT, "cypress", "screenshots"), { recursive: true, force: true }));

  // A screenshot for an unrelated test whose title happens to start the
  // same way as ours - must never be picked up by a loose prefix match.
  fs.writeFileSync(path.join(specDir, "Suite -- my test extra long title (failed).png"), "");
  fs.writeFileSync(path.join(specDir, "Suite -- my test.png"), ""); // no (failed) suffix - not our test's failure shot

  const noMatch = resolveScreenshotPath("cypress/e2e/tests/fixture.cy.js", ["Suite"], "my test");
  assert.equal(noMatch, null, "must not match on prefix alone or a non-failed screenshot");

  fs.writeFileSync(path.join(specDir, "Suite -- my test (failed).png"), "");
  const match = resolveScreenshotPath("cypress/e2e/tests/fixture.cy.js", ["Suite"], "my test");
  assert.equal(match, "cypress/screenshots/fixture.cy.js/Suite -- my test (failed).png");
});

test("resolveScreenshotPath: with multiple attempts, picks the highest-numbered one", (t) => {
  const specDir = path.join(ROOT, "cypress", "screenshots", "fixture2.cy.js");
  fs.mkdirSync(specDir, { recursive: true });
  t.after(() => fs.rmSync(path.join(ROOT, "cypress", "screenshots"), { recursive: true, force: true }));

  fs.writeFileSync(path.join(specDir, "Suite -- flaky test (failed) (1).png"), "");
  fs.writeFileSync(path.join(specDir, "Suite -- flaky test (failed) (2).png"), "");

  const match = resolveScreenshotPath("cypress/e2e/tests/fixture2.cy.js", ["Suite"], "flaky test");
  assert.equal(match, "cypress/screenshots/fixture2.cy.js/Suite -- flaky test (failed) (2).png");
});

test("resolveScreenshotPath: returns null when the spec's screenshot directory doesn't exist", () => {
  assert.equal(resolveScreenshotPath("cypress/e2e/tests/never_ran.cy.js", ["Suite"], "test"), null);
});

test("loadReports: reports a clear warning and returns no reports when reports/cypress is missing", (t) => {
  const reportsDir = path.join(ROOT, "reports", "cypress");
  fs.rmSync(path.join(ROOT, "reports"), { recursive: true, force: true });
  t.after(() => fs.rmSync(path.join(ROOT, "reports"), { recursive: true, force: true }));

  const { reports, warnings } = loadReports();
  assert.equal(reports.length, 0);
  assert.ok(warnings.some((w) => w.includes("No report directory")));
});

test("loadReports: skips an unparseable JSON file with a warning instead of throwing", (t) => {
  const reportsDir = path.join(ROOT, "reports", "cypress");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, "broken.json"), "{ not json");
  t.after(() => fs.rmSync(path.join(ROOT, "reports"), { recursive: true, force: true }));

  const { reports, warnings } = loadReports();
  assert.equal(reports.length, 0);
  assert.ok(warnings.some((w) => w.includes("Could not parse")));
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

test("truncateText: leaves short text untouched", () => {
  assert.equal(truncateText("short", 100), "short");
});

test("truncateText: caps long text with a visible marker", () => {
  const long = "x".repeat(200);
  const result = truncateText(long, 50);
  assert.equal(result.startsWith("x".repeat(50)), true);
  assert.match(result, /truncated/);
  assert.ok(result.length < long.length);
});

test("truncateText: passes through non-string input unchanged (e.g. null)", () => {
  assert.equal(truncateText(null, 50), null);
});

test("extractFailedTests: truncates a very long stack trace but never the error message itself", () => {
  const hugeStack = "at frame\n".repeat(2000); // well over MAX_STACK_CHARS
  const criticalMessage = "AssertionError: this exact sentence must survive untouched";
  const reports = [
    {
      results: [
        {
          file: "/cypress/e2e/tests/x.cy.js",
          suites: [
            {
              title: "Suite",
              suites: [],
              tests: [{ title: "fails", state: "failed", duration: 1, err: { message: criticalMessage, estack: hugeStack } }],
            },
          ],
        },
      ],
    },
  ];

  const [failed] = extractFailedTests(reports);
  assert.equal(failed.error.message, criticalMessage, "the message must never be truncated");
  assert.ok(failed.error.stack.length < hugeStack.length, "the stack must be truncated");
  assert.match(failed.error.stack, /truncated/);
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
