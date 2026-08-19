"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { selectKnowledge, buildSignalText, getRelevantBrowsers, getRelevantFrameworks } = require("./selector");
const { loadKnowledgeUnits } = require("./loader");

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

// --- Roadmap #16B.1: relevance-precision regression tests -----------------
//
// Unlike the fixture-based tests above (deliberately independent of the
// real production corpus, per the module comment), these tests load the
// REAL scripts/ai/knowledge/units/*.json corpus through the real loader,
// because the defect they guard against (#16B's finding) was specifically
// about two production units' overly-broad tags - "cypress" on
// framework-cypress-retry-timeout-semantics and "assertion" on
// qa-timeout-error-multiple-causes - each of which matched an
// always-or-frequently-present signal (the default framework marker;
// Cypress's own "AssertionError:"-prefixed message format) regardless of
// whether retry/timeout semantics were actually relevant to the failure.
// Testing against fixtures alone would not catch a regression in the real
// curated content, only in the selector algorithm (which was NOT changed
// here - see Phase 7's zero-diff verification).

const realUnits = loadKnowledgeUnits();

function realSelectedIds(context) {
  return selectKnowledge(context, realUnits).map((u) => u.id);
}

test("#16B.1 1: framework retry/timeout unit is NOT selected for a generic TypeError", () => {
  const context = makeContext({
    failedTests: [
      {
        title: "renders map",
        specFile: "cypress/e2e/tests/render.cy.js",
        error: { message: "TypeError: cannot read properties of undefined", stack: null },
      },
    ],
  });
  assert.doesNotMatch(realSelectedIds(context).join(","), /framework-cypress-retry-timeout-semantics/);
});

test("#16B.1 2: framework retry/timeout unit is NOT selected for a deterministic non-timeout assertion mismatch", () => {
  const context = makeContext({
    failedTests: [
      {
        title: "counts items",
        specFile: "cypress/e2e/tests/count.cy.js",
        error: { message: "AssertionError: expected 3 to equal 2", stack: null },
      },
    ],
  });
  assert.doesNotMatch(realSelectedIds(context).join(","), /framework-cypress-retry-timeout-semantics/);
});

test("#16B.1 3: framework retry/timeout unit IS selected for explicit 'Timed out retrying' evidence", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  assert.match(realSelectedIds(context).join(","), /framework-cypress-retry-timeout-semantics/);
});

test("#16B.1 4: timeout-multiple-causes unit is NOT selected merely because the error is an AssertionError", () => {
  const context = makeContext({
    failedTests: [
      {
        title: "counts items",
        specFile: "cypress/e2e/tests/count.cy.js",
        error: { message: "AssertionError: expected 3 to equal 2", stack: null },
      },
    ],
  });
  assert.doesNotMatch(realSelectedIds(context).join(","), /qa-timeout-error-multiple-causes/);
});

test("#16B.1 5: timeout-multiple-causes unit IS selected when explicit timeout/retry evidence exists", () => {
  const context = makeContext({ failedTests: [timeoutFailedTest()] });
  assert.match(realSelectedIds(context).join(","), /qa-timeout-error-multiple-causes/);
});

test("#16B.1 6: an unrelated network/HTTP failure does not select either timeout/retry unit solely because framework=Cypress", () => {
  const context = makeContext({
    failedTests: [
      {
        title: "fetches POIs",
        specFile: "cypress/e2e/tests/poi_data_requests.cy.js",
        error: { message: "AssertionError: expected 200 to equal 500 (HTTP request failed)", stack: null },
      },
    ],
  });
  const ids = realSelectedIds(context);
  assert.doesNotMatch(ids.join(","), /framework-cypress-retry-timeout-semantics/);
  assert.doesNotMatch(ids.join(","), /qa-timeout-error-multiple-causes/);
});

test("#16B.1 7: framework appliesTo filtering still works - the unit is eligible for Cypress contexts with genuine topical signals, and excluded when frameworks explicitly do not include cypress", () => {
  const cypressContext = makeContext({ failedTests: [timeoutFailedTest()] });
  assert.match(realSelectedIds(cypressContext).join(","), /framework-cypress-retry-timeout-semantics/);

  // Same topical signal, but the context explicitly declares a different
  // framework - appliesTo.frameworks: ["cypress"] must still exclude it,
  // proving eligibility scoping (untouched by this correction) still works
  // independently of the tag-matching fix.
  const nonCypressContext = makeContext({ failedTests: [timeoutFailedTest()], frameworks: ["playwright"] });
  assert.doesNotMatch(realSelectedIds(nonCypressContext).join(","), /framework-cypress-retry-timeout-semantics/);
});

test("#16B.1: real production corpus still contains exactly 4 units with no duplicate ids after the tag correction", () => {
  assert.equal(realUnits.length, 4);
  const ids = realUnits.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("#16B.1: corrected tags no longer contain the overbroad 'cypress'/'assertion' entries", () => {
  const frameworkUnitReal = realUnits.find((u) => u.id === "framework-cypress-retry-timeout-semantics");
  const timeoutUnitReal = realUnits.find((u) => u.id === "qa-timeout-error-multiple-causes");
  assert.deepEqual(frameworkUnitReal.tags, ["retry", "retry-ability", "timeout"]);
  assert.deepEqual(timeoutUnitReal.tags, ["timed out retrying", "timeout", "cy.get"]);
});

// --- Roadmap #16D.1: cross-browser differing-signature precision ----------
//
// Experiment K2 found that cross-browser-differing-signature-caution's old
// tags ("sameFailureSignature", "signature", "cross-browser") were naked
// substrings of buildSignalText()'s unconditional `sameFailureSignature=${...}`
// token, so the unit matched whenever browserCorrelation existed at all -
// true, false, null, or even a single-browser run - never actually gated on
// the statement's own condition (differing signatures, i.e. false). The
// fix is a knowledge-curation correction only (selector.js untouched): the
// unit's sole tag is now the literal "sameFailureSignature=false" token,
// which is a substring of the signal text only when the real correlation
// value is false.

function multiBrowserContext(browsers, failedBrowsers, sameFailureSignature) {
  return makeContext({
    browserCorrelation: {
      browsers,
      failedBrowsers,
      passedBrowsers: browsers.filter((b) => !failedBrowsers.includes(b)),
      primaryBrowser: failedBrowsers[0] || null,
      additionalFailedBrowsers: failedBrowsers.slice(1),
      failureScope: failedBrowsers.length > 1 ? "multi-browser" : "single-browser",
      sameFailureSignature,
    },
  });
}

test("#16D.1 1: sameFailureSignature=false selects cross-browser-differing-signature-caution (production corpus)", () => {
  const context = multiBrowserContext(["chrome", "edge"], ["chrome", "edge"], false);
  assert.match(realSelectedIds(context).join(","), /cross-browser-differing-signature-caution/);
});

test("#16D.1 2: sameFailureSignature=true does NOT select cross-browser-differing-signature-caution", () => {
  const context = multiBrowserContext(["chrome", "edge"], ["chrome", "edge"], true);
  assert.doesNotMatch(realSelectedIds(context).join(","), /cross-browser-differing-signature-caution/);
});

test("#16D.1 3: sameFailureSignature=null does NOT select cross-browser-differing-signature-caution", () => {
  const context = multiBrowserContext(["chrome", "edge"], ["chrome", "edge"], null);
  assert.doesNotMatch(realSelectedIds(context).join(","), /cross-browser-differing-signature-caution/);
});

test("#16D.1 4: a single-browser failure does NOT select cross-browser-differing-signature-caution", () => {
  const context = multiBrowserContext(["chrome"], ["chrome"], null);
  assert.doesNotMatch(realSelectedIds(context).join(","), /cross-browser-differing-signature-caution/);
});

test("#16D.1 5: generic multi-browser scope alone (no sameFailureSignature evidence) does NOT select the unit", () => {
  // failureScope is "multi-browser" and correlation exists, but the
  // signature comparison itself was never established (undefined, not
  // false) - the old "cross-browser" tag fired here; the corrected tag
  // must not.
  const context = makeContext({
    browserCorrelation: {
      browsers: ["chrome", "edge"],
      failedBrowsers: ["chrome", "edge"],
      passedBrowsers: [],
      primaryBrowser: "chrome",
      additionalFailedBrowsers: ["edge"],
      failureScope: "multi-browser",
    },
  });
  assert.doesNotMatch(realSelectedIds(context).join(","), /cross-browser-differing-signature-caution/);
});

test("#16D.1 6: sameFailureSignature=false still selects the unit across Chrome/Edge/Firefox combinations", () => {
  const combos = [
    ["chrome", "edge"],
    ["chrome", "firefox"],
    ["edge", "firefox"],
    ["chrome", "edge", "firefox"],
  ];
  for (const failedBrowsers of combos) {
    const context = multiBrowserContext(failedBrowsers, failedBrowsers, false);
    assert.match(
      realSelectedIds(context).join(","),
      /cross-browser-differing-signature-caution/,
      `expected selection for failedBrowsers=${failedBrowsers.join("+")}`
    );
  }
});

test("#16D.1 7: selection of the corrected unit is deterministic across repeated calls", () => {
  const context = multiBrowserContext(["chrome", "edge"], ["chrome", "edge"], false);
  const runs = Array.from({ length: 5 }, () => realSelectedIds(context));
  for (const run of runs) assert.deepEqual(run, runs[0]);
  assert.ok(runs[0].includes("cross-browser-differing-signature-caution"));
});

test("#16D.1: corrected tag is the precise 'sameFailureSignature=false' literal, not the old broad tag set", () => {
  const crossBrowserUnitReal = realUnits.find((u) => u.id === "cross-browser-differing-signature-caution");
  assert.deepEqual(crossBrowserUnitReal.tags, ["sameFailureSignature=false"]);
});

test("#16D.1: statement/appliesTo/priority/category/id are unchanged by the tag correction", () => {
  const crossBrowserUnitReal = realUnits.find((u) => u.id === "cross-browser-differing-signature-caution");
  assert.equal(crossBrowserUnitReal.category, "CROSS_BROWSER");
  assert.equal(crossBrowserUnitReal.priority, 8);
  assert.deepEqual(crossBrowserUnitReal.appliesTo, { browsers: null, frameworks: ["cypress"] });
  assert.match(crossBrowserUnitReal.statement, /differing failure signatures/);
});
