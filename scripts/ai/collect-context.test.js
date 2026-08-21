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

// Roadmap #19.7C (independent review finding): this file's real-path
// tests share reports/ with cypress-adapter.test.js's own real-path
// tests and analyze-failure.test.js's reports/ai/history.json tests -
// separate test files that Node's test runner may execute as
// concurrent processes by default. That pre-existing, cross-file
// filesystem race (not introduced or meaningfully worsened by #19.7 -
// confirmed via isolated A/B stress testing during review) can produce
// a transient ENOTEMPTY/EBUSY on this exact rmSync call. Node's own
// built-in retry (maxRetries/retryDelay, available since Node 14.14)
// is the standard mitigation for exactly this class of transient error
// and meaningfully reduces (though cannot, by itself, fully eliminate,
// since the root cause spans files outside this one) this file's own
// contribution to that pre-existing race. Fully eliminating the race
// would require changes to cypress-adapter.test.js/analyze-failure.test.js
// and/or package.json test:unit concurrency, both out of #19.7's scope.
function rmReportsTree() {
  fs.rmSync(path.join(ROOT, "reports"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

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
  rmReportsTree();
  t.after(() => rmReportsTree());

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

// =========================================================================
// Roadmap #19.7B - immutable Cypress historical full-context equivalence
// (see scripts/ai/cypress-equivalence.test.js's own module docstring for
// the full design/provenance rationale shared by both files).
//
// These two scenarios live here, not in cypress-equivalence.test.js,
// because they are the only #19.7 scenarios that must invoke the real
// main() against real fixed paths (reports/cypress, reports/ai/
// context.json) - this file is already the sole existing owner of that
// exact pattern (see the orchestration-wiring test immediately above),
// so keeping every fixed-path/main()-invoking test inside this one file
// avoids introducing a *new* cross-file race on top of the pre-existing,
// already-documented one between this file and analyze-failure.test.js's
// reports/ai/history.json-touching tests.
//
// HISTORICAL ORACLE: 1aff8f69484b7df5a293e7f1761f580fa2d3c9b0 (see
// cypress-equivalence.test.js for the full provenance statement - not
// repeated per-scenario here). Both goldens below were captured by
// running that exact commit's collect-context.js against the same
// fixture used against current code, in a disposable detached worktree,
// machine-comparing the two outputs, before transcribing the (proven-
// equal) result here.
//
// NORMALIZATION: generatedAt is dropped (unavoidable clock
// nondeterminism - see cypress-equivalence.test.js). Metadata is instead
// CONTROLLED via fixed synthetic environment variables (never a "close
// enough" comparison) so historical and current produce byte-identical
// metadata. relevantFiles is compared as a PROJECTION - only which keys
// were selected and their `truncated` flag - never raw file content or
// content length, because package.json/cypress.config.js content is
// volatile repository-global text unrelated to Cypress-adapter
// extraction (and could differ across Windows/Linux checkouts due to
// line-ending conventions), not part of the #19.7 extraction contract.
// =========================================================================

const CONTROLLED_ENV = {
  GITHUB_REPOSITORY: "example/repository",
  GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
  GITHUB_REF_NAME: "fixture-branch",
  GITHUB_RUN_ID: "fixture-run",
  GITHUB_EVENT_NAME: "push",
  TEST_BROWSER: "chrome",
  CI: "true",
};
const CONTROLLED_ENV_DELETIONS = ["GITHUB_HEAD_REF", "BROWSER", "CYPRESS_BROWSER", "npm_lifecycle_event"];

// Saves exact prior state (present-with-value vs genuinely absent) for
// every key this touches, sets the fixed synthetic values, and restores
// precisely - never leaves a previously-absent var as the string
// "undefined", and never leaves a previously-present var deleted.
function withControlledEnv(fn) {
  const allKeys = [...Object.keys(CONTROLLED_ENV), ...CONTROLLED_ENV_DELETIONS];
  const prior = new Map();
  for (const key of allKeys) {
    prior.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
  }
  try {
    for (const [key, value] of Object.entries(CONTROLLED_ENV)) process.env[key] = value;
    for (const key of CONTROLLED_ENV_DELETIONS) delete process.env[key];
    fn();
  } finally {
    for (const key of allKeys) {
      const priorValue = prior.get(key);
      if (priorValue === undefined) {
        delete process.env[key]; // was genuinely absent before - never restore as the string "undefined"
      } else {
        process.env[key] = priorValue;
      }
    }
  }
}

// The set of top-level context.json keys this #19.7 projection knows
// about and explicitly narrows relevantFiles for. Asserted exactly
// (not just "contains") before projecting, so a future PR that adds a
// new top-level context key doesn't silently disappear from this
// regression suite's comparison surface - it would instead fail this
// assertion and force a conscious decision about whether/how #19.7
// should represent the new field, rather than being invisibly ignored.
const KNOWN_CONTEXT_TOP_LEVEL_KEYS = [
  "generatedAt",
  "metadata",
  "testResults",
  "failedTests",
  "relevantFiles",
  "knownProjectConstraints",
  "warnings",
].sort();

// Note: callers must assert Object.keys(ctx).sort() against
// KNOWN_CONTEXT_TOP_LEVEL_KEYS themselves BEFORE calling this (i.e.
// before dropping generatedAt) - see the S1 full-context test below.
function projectFullContext(ctx) {
  const relevantFiles = {};
  for (const [key, val] of Object.entries(ctx.relevantFiles)) {
    relevantFiles[key] = { truncated: val.truncated };
  }
  return {
    metadata: ctx.metadata,
    testResults: ctx.testResults,
    failedTests: ctx.failedTests,
    relevantFiles,
    knownProjectConstraints: ctx.knownProjectConstraints,
    warnings: ctx.warnings,
  };
}

test("S1 full-context: current collector wiring matches the historical oracle's full projected context (metadata/testResults/failedTests/relevantFiles/constraints/warnings)", (t) => {
  const reportsDir = path.join(ROOT, "reports", "cypress");
  const outputFile = path.join(ROOT, "reports", "ai", "context.json");
  rmReportsTree();
  t.after(() => rmReportsTree());

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportsDir, "report.json"),
    JSON.stringify({
      stats: { tests: 3, passes: 1, failures: 1, pending: 1, duration: 42 },
      results: [
        {
          file: "cypress/e2e/tests/category_tree_behavior.cy.js",
          suites: [
            {
              title: "S1 Suite",
              suites: [],
              tests: [
                { title: "passes fine", state: "passed" },
                { title: "is pending", state: "pending" },
                { title: "fails here", state: "failed", duration: 12, err: { message: "AssertionError: boom", estack: "AssertionError: boom\n  at x" } },
              ],
            },
          ],
        },
      ],
    })
  );

  let written;
  withControlledEnv(() => {
    main();
    written = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  });

  // Exact top-level key check happens BEFORE dropping generatedAt, so
  // this test can still see it - see KNOWN_CONTEXT_TOP_LEVEL_KEYS.
  assert.deepStrictEqual(Object.keys(written).sort(), KNOWN_CONTEXT_TOP_LEVEL_KEYS);
  delete written.generatedAt;

  assert.deepStrictEqual(projectFullContext(written), {
    metadata: {
      projectId: "external-poi-sut",
      framework: "cypress",
      repository: "example/repository",
      commit: "0123456789abcdef0123456789abcdef01234567",
      branch: "fixture-branch",
      runId: "fixture-run",
      event: "push",
      browser: "chrome",
      ci: true,
    },
    testResults: {
      found: true,
      totals: { tests: 3, passed: 1, failed: 1, pending: 1, duration: 42 },
      specs: [{ specFile: "cypress/e2e/tests/category_tree_behavior.cy.js", tests: 3, passed: 1, failed: 1, pending: 1, duration: 42 }],
    },
    failedTests: [
      {
        title: "fails here",
        fullTitle: null,
        suite: "S1 Suite",
        specFile: "cypress/e2e/tests/category_tree_behavior.cy.js",
        status: "failed",
        duration: 12,
        error: { message: "AssertionError: boom", stack: "AssertionError: boom\n  at x" },
        screenshot: null,
      },
    ],
    relevantFiles: {
      "cypress.config.js": { truncated: false },
      "package.json": { truncated: false },
      "cypress/e2e/tests/category_tree_behavior.cy.js": { truncated: false },
      "cypress/e2e/pageObjects/navigation.js": { truncated: false },
      "cypress/e2e/pageObjects/categories.js": { truncated: false },
      "cypress/e2e/pageObjects/subCategories.js": { truncated: false },
    },
    knownProjectConstraints: TARGOMO_PROJECT_PROFILE.knownProjectConstraints,
    warnings: [],
  });
});

test("S11 warning merge order: current collector wiring matches the historical oracle - adapter warning before generic relevantFiles warning", (t) => {
  const reportsDir = path.join(ROOT, "reports", "cypress");
  const outputFile = path.join(ROOT, "reports", "ai", "context.json");
  rmReportsTree();
  t.after(() => rmReportsTree());

  fs.mkdirSync(reportsDir, { recursive: true });
  // An adapter/artifact warning (malformed JSON, never parsed) alongside
  // a valid report whose one failed test references a spec file that
  // does not exist on disk, triggering buildRelevantFiles's own generic
  // warning. Both warnings are real, unavoidable side effects of this
  // one fixture - not artificially forced.
  fs.writeFileSync(path.join(reportsDir, "broken.json"), "{ not valid json");
  fs.writeFileSync(
    path.join(reportsDir, "valid.json"),
    JSON.stringify({
      stats: { tests: 1, passes: 0, failures: 1, pending: 0, duration: 5 },
      results: [
        { file: "cypress/e2e/tests/s11_missing_spec.cy.js", suites: [{ title: "S11", suites: [], tests: [{ title: "fails, missing spec", state: "failed", err: { message: "m11" } }] }] },
      ],
    })
  );

  let written;
  withControlledEnv(() => {
    main();
    written = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  });

  // Exactly two warnings, in order: adapter warning first, generic
  // relevantFiles warning second - see cypress-equivalence.test.js's S8
  // for why the adapter warning's V8-generated JSON.parse diagnostic
  // tail is excluded from the frozen surface (RUNTIME_VOLATILE_WARNING_
  // PROJECTION) while its stable project-owned prefix and the generic
  // warning's exact text are still frozen exactly.
  assert.equal(written.warnings.length, 2);
  const expectedAdapterWarningPrefix = `Could not parse ${path.join("reports", "cypress", "broken.json")}: `;
  assert.ok(
    written.warnings[0].startsWith(expectedAdapterWarningPrefix) && written.warnings[0].length > expectedAdapterWarningPrefix.length,
    `warnings[0] should be the adapter warning starting with "${expectedAdapterWarningPrefix}"; got: ${written.warnings[0]}`
  );
  assert.equal(written.warnings[1], "Failed spec source not found on disk: cypress/e2e/tests/s11_missing_spec.cy.js");
});
