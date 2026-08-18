"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { selectKnowledge, buildSignalText, getRelevantBrowsers, getRelevantFrameworks } = require("./selector");

// --- fixtures (independent of the real scripts/ai/knowledge/units/*.json
// production corpus - these test their own semantic shapes, not today's
// specific curated content, so they stay valid even if production units
// are added/edited/removed later) ---------------------------------------

function makeUnit(overrides = {}) {
  return {
    id: "fixture-unit",
    category: "GENERAL_QA",
    sourceType: "CURATED_INTERNAL",
    source: null,
    verifiedAt: "2026-08-18",
    tags: ["fixture-tag"],
    appliesTo: { browsers: null, frameworks: null },
    statement: "A fixture statement used for selector testing.",
    priority: 1,
    ...overrides,
  };
}

const firefoxUnit = makeUnit({
  id: "project-firefox-execution-environment-split",
  category: "PROJECT",
  sourceType: "PROJECT_VERIFIED",
  tags: ["firefox"],
  appliesTo: { browsers: ["firefox"], frameworks: ["cypress"] },
  statement: "Firefox runs in a different execution environment in this project; that split alone is not evidence of a Firefox-specific defect.",
  priority: 10,
});

const chromeOnlyUnit = makeUnit({
  id: "chrome-only-fixture",
  tags: ["chrome-only-quirk"],
  appliesTo: { browsers: ["chrome"], frameworks: ["cypress"] },
  statement: "A chrome-only fixture statement.",
  priority: 9,
});

const crossBrowserUnit = makeUnit({
  id: "cross-browser-differing-signature-caution",
  category: "CROSS_BROWSER",
  tags: ["browserCorrelation", "sameFailureSignature", "cross-browser", "signature"],
  appliesTo: { browsers: null, frameworks: ["cypress"] },
  statement: "Differing signatures across browsers can indicate different failure paths but do not prove a browser-specific cause.",
  priority: 8,
});

const timeoutUnit = makeUnit({
  id: "qa-timeout-error-multiple-causes",
  tags: ["timed out retrying", "timeout", "cy.get", "assertion"],
  appliesTo: { browsers: null, frameworks: ["cypress"] },
  statement: "A timeout error can arise from several distinct mechanisms; the timeout text alone does not establish which one occurred.",
  priority: 5,
});

const frameworkUnit = makeUnit({
  id: "framework-cypress-retry-timeout-semantics",
  category: "FRAMEWORK",
  tags: ["cypress", "retry", "retry-ability"],
  appliesTo: { browsers: null, frameworks: ["cypress"] },
  statement: "Cypress retries retryable assertions until timeout; a timeout establishes the condition never became true in time, not why.",
  priority: 5,
});

const irrelevantHighPriorityUnit = makeUnit({
  id: "irrelevant-network-unit",
  tags: ["network outage", "dns failure", "connection reset"],
  appliesTo: { browsers: null, frameworks: null },
  statement: "A totally unrelated network-outage statement.",
  priority: 999,
});

function makeContext(overrides = {}) {
  return {
    generatedAt: "2026-08-18T00:00:00.000Z",
    metadata: { browser: "chrome", ci: true },
    testResults: { found: true, totals: {}, specs: [] },
    failedTests: [],
    relevantFiles: {},
    knownProjectConstraints: [],
    browserCorrelation: null,
    ...overrides,
  };
}

function timeoutFailedTest() {
  return {
    title: "should select the Gastronomy category",
    fullTitle: "Category tree > should select the Gastronomy category",
    specFile: "cypress/e2e/tests/select_group_POI.cy.js",
    error: { message: "Timed out retrying after 4000ms: expected cy.get('#mat-checkbox-3') to be checked", stack: null },
  };
}

// --- 1-4: relevance, exclusion, zero-match, determinism -------------------

test("relevant knowledge is selected when tags match the signal text", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const result = selectKnowledge(context, [timeoutUnit, frameworkUnit]);
  const ids = result.map((r) => r.id);
  assert.ok(ids.includes("qa-timeout-error-multiple-causes"));
});

test("irrelevant knowledge is excluded when no tag matches", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const result = selectKnowledge(context, [irrelevantHighPriorityUnit]);
  assert.deepEqual(result, []);
});

test("zero match returns []", () => {
  const context = makeContext({ failedTests: [] });
  const result = selectKnowledge(context, [firefoxUnit, crossBrowserUnit, timeoutUnit]);
  assert.deepEqual(result, []);
});

test("repeated calls with the same input are deterministic", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const units = [timeoutUnit, frameworkUnit, irrelevantHighPriorityUnit];
  const first = selectKnowledge(context, units);
  const second = selectKnowledge(context, units);
  assert.deepEqual(first, second);
});

// --- 5-7: ordering / tie-breaks -----------------------------------------

test("deterministic ordering: higher match score ranks first", () => {
  // Deliberately synthetic, non-overlapping tag vocabulary (unlike the
  // realistic fixtures elsewhere in this file) so the test isolates pure
  // score ordering from any tie-break - unitThreeHits must outrank
  // unitOneHit purely on match count, with priority equal on both.
  const unitThreeHits = makeUnit({ id: "three-hits", tags: ["alpha-tag", "beta-tag", "gamma-tag"], priority: 1 });
  const unitOneHit = makeUnit({ id: "one-hit", tags: ["alpha-tag"], priority: 1 });
  const context = makeContext({ knownProjectConstraints: ["alpha-tag beta-tag gamma-tag all appear here"] });
  const result = selectKnowledge(context, [unitOneHit, unitThreeHits]);
  assert.deepEqual(result.map((r) => r.id), ["three-hits", "one-hit"]);
});

test("priority tie-break: equal score, higher priority ranks first", () => {
  const unitLow = makeUnit({ id: "low-priority", tags: ["shared-tag"], priority: 1 });
  const unitHigh = makeUnit({ id: "high-priority", tags: ["shared-tag"], priority: 9 });
  const context = makeContext({ knownProjectConstraints: ["shared-tag appears here"] });
  const result = selectKnowledge(context, [unitLow, unitHigh]);
  assert.deepEqual(
    result.map((r) => r.id),
    ["high-priority", "low-priority"]
  );
});

test("id tie-break: equal score and equal priority sorts by id ascending", () => {
  const unitB = makeUnit({ id: "b-unit", tags: ["shared-tag"], priority: 3 });
  const unitA = makeUnit({ id: "a-unit", tags: ["shared-tag"], priority: 3 });
  const context = makeContext({ knownProjectConstraints: ["shared-tag appears here"] });
  const result = selectKnowledge(context, [unitB, unitA]);
  assert.deepEqual(
    result.map((r) => r.id),
    ["a-unit", "b-unit"]
  );
});

// --- 8-9: appliesTo filtering --------------------------------------------

test("browser appliesTo filtering: Firefox unit selected for a relevant Firefox context", () => {
  const context = makeContext({
    metadata: { browser: "firefox", ci: true },
    browserCorrelation: {
      browsers: ["chrome", "edge", "firefox"],
      failedBrowsers: ["firefox"],
      passedBrowsers: ["chrome", "edge"],
      primaryBrowser: "firefox",
      additionalFailedBrowsers: [],
      failureScope: "single-browser",
      sameFailureSignature: null,
    },
  });
  const result = selectKnowledge(context, [firefoxUnit]);
  assert.deepEqual(result.map((r) => r.id), ["project-firefox-execution-environment-split"]);
});

test("browser appliesTo filtering excludes a unit even when its tags DO match (structural filter is independent of tag matching)", () => {
  // Deliberately uses a tag that WOULD score > 0 against the chrome
  // context's own signal text, so this unit is excluded ONLY by the
  // appliesTo.browsers structural gate - not incidentally masked by the
  // tag-matching filter the way a browser-named tag like "firefox" would
  // be. This decouples the two mechanisms so a mutation removing the
  // structural filter is actually caught (see #15B.2 Phase 17 mutation
  // evidence).
  const firefoxScopedGenericUnit = makeUnit({
    id: "firefox-scoped-generic-timeout-unit",
    tags: ["timed out retrying"],
    appliesTo: { browsers: ["firefox"], frameworks: ["cypress"] },
  });
  const context = makeContext({ metadata: { browser: "chrome" }, failedTests: [timeoutFailedTest()] });
  const result = selectKnowledge(context, [firefoxScopedGenericUnit]);
  assert.deepEqual(result, []);
});

test("browser appliesTo filtering: Firefox unit excluded for an unrelated Chrome-only context", () => {
  const context = makeContext({
    metadata: { browser: "chrome", ci: true },
    browserCorrelation: {
      browsers: ["chrome", "edge"],
      failedBrowsers: ["chrome"],
      passedBrowsers: ["edge"],
      primaryBrowser: "chrome",
      additionalFailedBrowsers: [],
      failureScope: "single-browser",
      sameFailureSignature: null,
    },
  });
  const result = selectKnowledge(context, [firefoxUnit]);
  assert.deepEqual(result, []);
});

test("framework appliesTo filtering: a Cypress-scoped unit applies by default (framework is cypress)", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const result = selectKnowledge(context, [timeoutUnit]);
  assert.equal(result.length, 1);
});

test("framework appliesTo filtering: a unit scoped to an unrelated framework is excluded", () => {
  const playwrightOnlyUnit = makeUnit({
    id: "playwright-only-fixture",
    tags: ["timed out retrying"],
    appliesTo: { browsers: null, frameworks: ["playwright"] },
  });
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const result = selectKnowledge(context, [playwrightOnlyUnit]);
  assert.deepEqual(result, []);
});

// --- 10-11: budget -------------------------------------------------------

test("maxUnits is enforced even when more candidates are relevant", () => {
  const units = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    makeUnit({ id: `unit-${n}`, tags: ["shared-tag"], priority: n })
  );
  const context = makeContext({ knownProjectConstraints: ["shared-tag appears here"] });
  const result = selectKnowledge(context, units, { maxUnits: 3 });
  assert.equal(result.length, 3);
  // Highest priority first, since all scores are tied.
  assert.deepEqual(result.map((r) => r.id), ["unit-7", "unit-6", "unit-5"]);
});

test("maxChars is enforced: a unit that would exceed the budget on its own is skipped, yielding []", () => {
  const bigUnit = makeUnit({
    id: "big-unit",
    tags: ["shared-tag"],
    priority: 10,
    statement: "x".repeat(50),
  });
  const context = makeContext({ knownProjectConstraints: ["shared-tag appears here"] });
  // The only candidate is bigger than the entire budget, so nothing fits.
  const result = selectKnowledge(context, [bigUnit], { maxChars: 40 });
  assert.deepEqual(result, []);
});

test("maxChars skip-and-continue: a smaller lower-ranked unit still fits after a bigger higher-ranked one is skipped", () => {
  const bigUnit = makeUnit({ id: "big-unit", tags: ["shared-tag"], priority: 10, statement: "x".repeat(50) });
  const smallUnit = makeUnit({ id: "small-unit", tags: ["shared-tag"], priority: 1, statement: "y".repeat(10) });
  const context = makeContext({ knownProjectConstraints: ["shared-tag appears here"] });
  // Budget can't fit the big unit (50 > 20) but can fit the small one (10 <= 20).
  const result = selectKnowledge(context, [bigUnit, smallUnit], { maxChars: 20 });
  assert.deepEqual(result.map((r) => r.id), ["small-unit"]);
});

// --- 12: statements are never truncated -----------------------------------

test("knowledge statements are never truncated, even near the budget edge", () => {
  const unit = makeUnit({ id: "exact-fit-unit", tags: ["shared-tag"], statement: "z".repeat(30) });
  const context = makeContext({ knownProjectConstraints: ["shared-tag appears here"] });
  const result = selectKnowledge(context, [unit], { maxChars: 30 });
  assert.equal(result[0].statement.length, 30);
  assert.equal(result[0].statement, "z".repeat(30));
});

// --- 13: same input + same units => deeply identical output --------------

test("same input + same units array => deeply identical output object graph", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const units = [timeoutUnit, frameworkUnit];
  assert.deepEqual(selectKnowledge(context, units), selectKnowledge(context, units));
});

// --- 16: cross-browser knowledge selected when browserCorrelation relevant

test("cross-browser knowledge is selected when browserCorrelation signals differing signatures", () => {
  const context = makeContext({
    browserCorrelation: {
      browsers: ["chrome", "firefox"],
      failedBrowsers: ["chrome", "firefox"],
      passedBrowsers: [],
      primaryBrowser: "chrome",
      additionalFailedBrowsers: ["firefox"],
      failureScope: "multi-browser",
      sameFailureSignature: false,
    },
  });
  const result = selectKnowledge(context, [crossBrowserUnit]);
  assert.deepEqual(result.map((r) => r.id), ["cross-browser-differing-signature-caution"]);
});

test("cross-browser knowledge is excluded for a single-browser context with no correlation signal", () => {
  const context = makeContext({ browserCorrelation: null });
  const result = selectKnowledge(context, [crossBrowserUnit]);
  assert.deepEqual(result, []);
});

// --- 17-18: generic timeout unit ------------------------------------------

test("generic timeout unit is selected for timeout evidence", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const result = selectKnowledge(context, [timeoutUnit]);
  assert.deepEqual(result.map((r) => r.id), ["qa-timeout-error-multiple-causes"]);
});

test("generic timeout unit is excluded when no timeout signal is present", () => {
  // Deliberately avoids "AssertionError"/"assertion"/"timeout"/"cy.get"
  // text - a real Cypress "AssertionError: ..." message would itself
  // substring-match the timeoutUnit's own "assertion" tag, which is
  // realistic but would defeat this test's purpose of proving exclusion
  // when none of the unit's signals are present at all.
  const context = makeContext({
    failedTests: [
      {
        title: "network call fails",
        fullTitle: "API > network call fails",
        specFile: "cypress/e2e/tests/poi_data_requests.cy.js",
        error: { message: "NetworkError: connection reset by peer", stack: null },
      },
    ],
  });
  const result = selectKnowledge(context, [timeoutUnit]);
  assert.deepEqual(result, []);
});

// --- 19: classification is not required/used ------------------------------

test("selection works identically whether or not a (hypothetical) classification field is present on the context", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const withoutClassification = selectKnowledge(context, [timeoutUnit]);
  const withClassification = selectKnowledge({ ...context, classification: "TEST_BUG" }, [timeoutUnit]);
  assert.deepEqual(withoutClassification, withClassification);
});

test("selector.js source never READS a classification/rootCause/recommendedFix/confidence field (model-output fields)", () => {
  // The module's own doc comment explicitly documents that these fields
  // are deliberately excluded (prose, not usage) - so this checks for the
  // property-access pattern (".classification", "context.rootCause", etc.)
  // rather than banning the bare word from appearing in a comment at all.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "selector.js"), "utf8");
  assert.doesNotMatch(source, /\.classification\b/);
  assert.doesNotMatch(source, /\.rootCause\b/);
  assert.doesNotMatch(source, /\.recommendedFix\b/);
  assert.doesNotMatch(source, /\.confidence\b/);
  assert.doesNotMatch(source, /\.shouldCreateBug\b/);
});

// --- 20: no network/provider calls ----------------------------------------

test("selector.js source contains no network/provider/secret references", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "selector.js"), "utf8");
  assert.doesNotMatch(source, /\bfetch\(/);
  assert.doesNotMatch(source, /require\(["']https?["']\)/);
  assert.doesNotMatch(source, /GROQ|AI_API_KEY|provider\.analyze/i);
});

test("single-call invariant: selector.js never requires the providers module at all", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "selector.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'`][^"'`]*providers[^"'`]*["'`]\)/);
});

test("single-call invariant: calling selectKnowledge many times never invokes any function (no hidden provider callback)", () => {
  // selectKnowledge's signature (context, units, options) accepts no
  // callback/provider argument at all - this test documents that fact by
  // calling it repeatedly with plain data only and confirming it never
  // throws or requires anything beyond its three plain arguments.
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  for (let i = 0; i < 25; i += 1) {
    selectKnowledge(context, [timeoutUnit, frameworkUnit, irrelevantHighPriorityUnit]);
  }
  // .length only counts parameters before the first default value
  // (options = {}), so 2 is correct here - context and units are
  // required, options is optional - and no 4th (callback/provider)
  // parameter exists at all.
  assert.equal(selectKnowledge.length, 2, "selectKnowledge(context, units, options=) takes no callback/provider argument");
});

// --- Adversarial A: conflicting knowledge units both surface ---------------

test("adversarial A: two independently relevant, semantically conflicting units both survive selection", () => {
  const flakyLeaningUnit = makeUnit({
    id: "flaky-leaning-unit",
    tags: ["intermittent"],
    statement: "An intermittent pass/fail pattern across runs can suggest a flaky test rather than a deterministic break.",
    priority: 5,
  });
  const deterministicLeaningUnit = makeUnit({
    id: "deterministic-leaning-unit",
    tags: ["intermittent"],
    statement: "A consistent run of failures with no passes is not typically explained by flakiness.",
    priority: 5,
  });
  const context = makeContext({ knownProjectConstraints: ["an intermittent signal was observed"] });
  const result = selectKnowledge(context, [flakyLeaningUnit, deterministicLeaningUnit]);
  const ids = result.map((r) => r.id).sort();
  assert.deepEqual(ids, ["deterministic-leaning-unit", "flaky-leaning-unit"]);
});

// --- Adversarial B: high-priority irrelevant unit must not beat relevance -

test("adversarial B: a high-priority but irrelevant unit does not outrank a lower-priority relevant unit", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const result = selectKnowledge(context, [irrelevantHighPriorityUnit, timeoutUnit]);
  assert.deepEqual(result.map((r) => r.id), ["qa-timeout-error-multiple-causes"]);
});

// --- Adversarial C: browser-specific overfitting ---------------------------

test("adversarial C: a Firefox-scoped unit is not surfaced merely because the repo generally runs Firefox", () => {
  // No browserCorrelation, current run's own browser is chrome - the
  // CURRENT context must satisfy the scoping condition, not general
  // repository capability.
  const context = makeContext({ metadata: { browser: "chrome", ci: true } });
  const result = selectKnowledge(context, [firefoxUnit]);
  assert.deepEqual(result, []);
});

test("adversarial C: chrome-only unit is excluded when firefox is the relevant browser", () => {
  const context = makeContext({
    metadata: { browser: "firefox", ci: true },
    browserCorrelation: {
      browsers: ["firefox"],
      failedBrowsers: ["firefox"],
      passedBrowsers: [],
      primaryBrowser: "firefox",
      additionalFailedBrowsers: [],
      failureScope: "single-browser",
      sameFailureSignature: null,
    },
  });
  const result = selectKnowledge(context, [chromeOnlyUnit]);
  assert.deepEqual(result, []);
});

// --- Adversarial D: giant knowledge corpus still respects the budget -----

test("adversarial D: a synthetic large corpus still respects maxUnits and maxChars", () => {
  const units = Array.from({ length: 200 }, (_, i) =>
    makeUnit({ id: `synthetic-${String(i).padStart(3, "0")}`, tags: ["shared-tag"], priority: i, statement: "s".repeat(100) })
  );
  const context = makeContext({ knownProjectConstraints: ["shared-tag appears here"] });
  const result = selectKnowledge(context, units, { maxUnits: 5, maxChars: 2000 });
  assert.ok(result.length <= 5);
  const totalChars = result.reduce((sum, r) => sum + r.statement.length, 0);
  assert.ok(totalChars <= 2000);
});

// --- helper function coverage: buildSignalText / getRelevantBrowsers -----

test("buildSignalText is deterministic for the same context", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  assert.equal(buildSignalText(context), buildSignalText(context));
});

test("getRelevantBrowsers prefers browserCorrelation.failedBrowsers over metadata.browser", () => {
  const context = makeContext({
    metadata: { browser: "chrome" },
    browserCorrelation: {
      browsers: ["chrome", "firefox"],
      failedBrowsers: ["firefox"],
      passedBrowsers: ["chrome"],
      primaryBrowser: "firefox",
      additionalFailedBrowsers: [],
      failureScope: "single-browser",
      sameFailureSignature: null,
    },
  });
  assert.deepEqual(getRelevantBrowsers(context), ["firefox"]);
});

test("getRelevantBrowsers falls back to metadata.browser when no browserCorrelation is present", () => {
  const context = makeContext({ metadata: { browser: "edge" }, browserCorrelation: null });
  assert.deepEqual(getRelevantBrowsers(context), ["edge"]);
});

test("getRelevantFrameworks defaults to cypress when context.frameworks is absent", () => {
  const context = makeContext();
  assert.deepEqual(getRelevantFrameworks(context), ["cypress"]);
});

test("default maxUnits/maxChars apply when options is omitted entirely", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  const result = selectKnowledge(context, [timeoutUnit]);
  assert.equal(result.length, 1);
});
