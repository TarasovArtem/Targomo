"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readBrowserInputs,
  shouldRunAiTriage,
  selectPrimaryFailure,
  aggregateBrowserInputs,
  buildBrowserCorrelation,
  DEFAULT_BROWSER_PRIORITY,
} = require("./aggregate-browser-context");
const { buildFailureReport, validateAnalysisItem } = require("./analyze-failure");

function browserInput(browser, outcome, overrides = {}) {
  return {
    browser,
    outcome,
    context: outcome === "failure" ? fakeContext(browser) : null,
    history: null,
    ...overrides,
  };
}

function fakeContext(browser, overrides = {}) {
  const title = overrides.title || `${browser} failing test`;
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    metadata: { repository: "o/r", commit: "abc123", branch: "main", runId: null, event: null, browser, ci: true },
    testResults: { found: true, totals: { tests: 1, passed: 0, failed: 1, pending: 0, duration: 100 }, specs: [] },
    failedTests: [
      {
        title,
        fullTitle: overrides.fullTitle || title,
        specFile: overrides.specFile || "cypress/e2e/tests/example.cy.js",
        suite: "Example",
        status: "failed",
        duration: 500,
        error: { message: overrides.message || "AssertionError: nope", stack: "AssertionError\n  at example.cy.js:1:1" },
        screenshot: null,
      },
    ],
    relevantFiles: {},
    warnings: [],
  };
}

// --- shouldRunAiTriage ------------------------------------------------

test("shouldRunAiTriage: no failures -> AI analysis not required", () => {
  const inputs = [browserInput("chrome", "success"), browserInput("edge", "success")];
  assert.equal(shouldRunAiTriage(inputs), false);
});

test("shouldRunAiTriage: one failure -> AI analysis required", () => {
  const inputs = [browserInput("chrome", "failure"), browserInput("edge", "success")];
  assert.equal(shouldRunAiTriage(inputs), true);
});

test("shouldRunAiTriage: two failures -> AI analysis required", () => {
  const inputs = [browserInput("chrome", "failure"), browserInput("edge", "failure")];
  assert.equal(shouldRunAiTriage(inputs), true);
});

test("shouldRunAiTriage: empty input (no browser data at all) -> not required", () => {
  assert.equal(shouldRunAiTriage([]), false);
});

// --- selectPrimaryFailure -----------------------------------------------

test("selectPrimaryFailure: both fail -> chrome wins (default priority order)", () => {
  const inputs = [browserInput("chrome", "failure"), browserInput("edge", "failure")];
  const primary = selectPrimaryFailure(inputs);
  assert.equal(primary.browser, "chrome");
});

test("selectPrimaryFailure: only edge fails -> edge is primary", () => {
  const inputs = [browserInput("chrome", "success"), browserInput("edge", "failure")];
  const primary = selectPrimaryFailure(inputs);
  assert.equal(primary.browser, "edge");
});

test("selectPrimaryFailure: nothing failed -> null", () => {
  const inputs = [browserInput("chrome", "success"), browserInput("edge", "success")];
  assert.equal(selectPrimaryFailure(inputs), null);
});

test("selectPrimaryFailure: a browser outside the known priority order still gets selected", () => {
  const inputs = [browserInput("firefox", "failure")];
  const primary = selectPrimaryFailure(inputs, DEFAULT_BROWSER_PRIORITY);
  assert.equal(primary.browser, "firefox");
});

// --- aggregateBrowserInputs (the deterministic decision layer) ----------

test("aggregateBrowserInputs: chrome+edge both pass -> shouldRun false, no primary, no correlation", () => {
  const inputs = [browserInput("chrome", "success"), browserInput("edge", "success")];
  const result = aggregateBrowserInputs(inputs);
  assert.deepEqual(result, { shouldRun: false, primary: null, otherFailedBrowsers: [], correlation: null });
});

test("aggregateBrowserInputs: chrome+edge both fail -> deterministically picks chrome, notes edge", () => {
  const inputs = [browserInput("chrome", "failure"), browserInput("edge", "failure")];
  const result = aggregateBrowserInputs(inputs);
  assert.equal(result.shouldRun, true);
  assert.equal(result.primary.browser, "chrome");
  assert.deepEqual(result.otherFailedBrowsers, ["edge"]);
});

test("aggregateBrowserInputs: is deterministic across repeated calls with the same input", () => {
  const inputs = [browserInput("chrome", "failure"), browserInput("edge", "failure")];
  const first = aggregateBrowserInputs(inputs);
  const second = aggregateBrowserInputs(inputs);
  assert.equal(first.primary.browser, second.primary.browser);
});

// --- buildBrowserCorrelation (deterministic cross-browser evidence, PR #33) --

test("correlation: chrome fails, edge passes -> single-browser, failed=[chrome], passed=[edge]", () => {
  const inputs = [browserInput("chrome", "failure"), browserInput("edge", "success")];
  const { correlation } = aggregateBrowserInputs(inputs);

  assert.deepEqual(correlation.browsers, ["chrome", "edge"]);
  assert.deepEqual(correlation.failedBrowsers, ["chrome"]);
  assert.deepEqual(correlation.passedBrowsers, ["edge"]);
  assert.equal(correlation.primaryBrowser, "chrome");
  assert.deepEqual(correlation.additionalFailedBrowsers, []);
  assert.equal(correlation.failureScope, "single-browser");
  // Fewer than two failed browsers - nothing to compare.
  assert.equal(correlation.sameFailureSignature, null);
});

test("correlation: chrome passes, edge fails -> single-browser, failed=[edge], passed=[chrome]", () => {
  const inputs = [browserInput("chrome", "success"), browserInput("edge", "failure")];
  const { correlation } = aggregateBrowserInputs(inputs);

  assert.deepEqual(correlation.failedBrowsers, ["edge"]);
  assert.deepEqual(correlation.passedBrowsers, ["chrome"]);
  assert.equal(correlation.primaryBrowser, "edge");
  assert.deepEqual(correlation.additionalFailedBrowsers, []);
  assert.equal(correlation.failureScope, "single-browser");
  assert.equal(correlation.sameFailureSignature, null);
});

test("correlation: chrome+edge fail with the same evidence -> multi-browser, sameFailureSignature=true", () => {
  const sharedFailure = { title: "shared failing test", specFile: "cypress/e2e/tests/example.cy.js", message: "AssertionError: same problem" };
  const inputs = [
    browserInput("chrome", "failure", { context: fakeContext("chrome", sharedFailure) }),
    browserInput("edge", "failure", { context: fakeContext("edge", sharedFailure) }),
  ];
  const { correlation } = aggregateBrowserInputs(inputs);

  assert.equal(correlation.primaryBrowser, "chrome");
  assert.deepEqual(correlation.additionalFailedBrowsers, ["edge"]);
  assert.equal(correlation.failureScope, "multi-browser");
  assert.equal(correlation.sameFailureSignature, true);
});

test("correlation: chrome+edge fail with different evidence -> multi-browser, sameFailureSignature=false", () => {
  const inputs = [
    browserInput("chrome", "failure", { context: fakeContext("chrome", { title: "test A", message: "AssertionError: A" }) }),
    browserInput("edge", "failure", { context: fakeContext("edge", { title: "test B", message: "AssertionError: B" }) }),
  ];
  const { correlation } = aggregateBrowserInputs(inputs);

  assert.equal(correlation.failureScope, "multi-browser");
  assert.equal(correlation.sameFailureSignature, false);
});

test("correlation: chrome+edge fail but one has no usable context -> sameFailureSignature is unknown (null), never forced false", () => {
  const inputs = [
    browserInput("chrome", "failure", { context: fakeContext("chrome") }),
    browserInput("edge", "failure", { context: null }),
  ];
  const { correlation } = aggregateBrowserInputs(inputs);

  assert.equal(correlation.failureScope, "multi-browser");
  assert.equal(correlation.sameFailureSignature, null);
});

test("correlation: both browsers pass -> shouldRunAiTriage is false (no analysis, no correlation needed)", () => {
  const inputs = [browserInput("chrome", "success"), browserInput("edge", "success")];
  const result = aggregateBrowserInputs(inputs);
  assert.equal(result.shouldRun, false);
  assert.equal(result.correlation, null);
});

test("correlation: >2 browsers (chrome fail, edge fail same signature, firefox pass) - arrays represent all three correctly", () => {
  const sharedFailure = { title: "shared failing test", specFile: "cypress/e2e/tests/example.cy.js", message: "AssertionError: same problem" };
  const priorityOrder = ["chrome", "edge", "firefox"];
  const inputs = [
    browserInput("chrome", "failure", { context: fakeContext("chrome", sharedFailure) }),
    browserInput("edge", "failure", { context: fakeContext("edge", sharedFailure) }),
    browserInput("firefox", "success"),
  ];
  const { correlation } = aggregateBrowserInputs(inputs, priorityOrder);

  assert.deepEqual(correlation.browsers, ["chrome", "edge", "firefox"]);
  assert.deepEqual(correlation.failedBrowsers, ["chrome", "edge"]);
  assert.deepEqual(correlation.passedBrowsers, ["firefox"]);
  assert.equal(correlation.primaryBrowser, "chrome");
  assert.deepEqual(correlation.additionalFailedBrowsers, ["edge"]);
  assert.equal(correlation.failureScope, "multi-browser");
  assert.equal(correlation.sameFailureSignature, true);
});

test("correlation: an unrecognized browser not in priorityOrder still sorts deterministically (alphabetically, after known browsers)", () => {
  const inputs = [
    browserInput("zeta-browser", "failure"),
    browserInput("chrome", "failure"),
    browserInput("edge", "success"),
  ];
  const correlation = buildBrowserCorrelation(inputs, inputs[1], DEFAULT_BROWSER_PRIORITY);
  assert.deepEqual(correlation.browsers, ["chrome", "edge", "zeta-browser"]);
});

// --- readBrowserInputs (I/O layer, isolated from the repo's own reports/) --

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-browser-context-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("readBrowserInputs: reads a valid browser-result.json plus context/history", () => {
  withTempDir((dir) => {
    const chromeDir = path.join(dir, "chrome");
    fs.mkdirSync(chromeDir, { recursive: true });
    fs.writeFileSync(path.join(chromeDir, "browser-result.json"), JSON.stringify({ browser: "chrome", outcome: "failure" }));
    fs.writeFileSync(path.join(chromeDir, "context.json"), JSON.stringify(fakeContext("chrome")));
    fs.writeFileSync(path.join(chromeDir, "history.json"), JSON.stringify({ available: true, passes: 5, failures: 1 }));

    const inputs = readBrowserInputs(dir, ["chrome"]);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].browser, "chrome");
    assert.equal(inputs[0].outcome, "failure");
    assert.ok(inputs[0].context);
    assert.ok(inputs[0].history);
  });
});

test("readBrowserInputs: gracefully skips a browser whose artifact was never downloaded (missing directory)", () => {
  withTempDir((dir) => {
    const chromeDir = path.join(dir, "chrome");
    fs.mkdirSync(chromeDir, { recursive: true });
    fs.writeFileSync(path.join(chromeDir, "browser-result.json"), JSON.stringify({ browser: "chrome", outcome: "success" }));
    // "edge" directory intentionally does not exist at all.

    const inputs = readBrowserInputs(dir, ["chrome", "edge"]);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].browser, "chrome");
  });
});

test("readBrowserInputs: gracefully skips a browser whose browser-result.json is unparseable", () => {
  withTempDir((dir) => {
    const edgeDir = path.join(dir, "edge");
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.writeFileSync(path.join(edgeDir, "browser-result.json"), "{ not json");

    const inputs = readBrowserInputs(dir, ["edge"]);
    assert.deepEqual(inputs, []);
  });
});

test("readBrowserInputs: a browser input with no context.json (e.g. it actually passed) has context: null", () => {
  withTempDir((dir) => {
    const edgeDir = path.join(dir, "edge");
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.writeFileSync(path.join(edgeDir, "browser-result.json"), JSON.stringify({ browser: "edge", outcome: "success" }));

    const inputs = readBrowserInputs(dir, ["edge"]);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].context, null);
    assert.equal(inputs[0].history, null);
  });
});

// --- integration: the actual Definition-of-Done claim -------------------
// Proves "two failed browsers -> exactly one provider.analyze() call"
// using the real aggregation decision plus the real buildFailureReport()
// (the same function main() in analyze-failure.js calls) - not just an
// architectural claim about the YAML.

test("integration: two failed browser inputs still result in exactly one provider.analyze() call", async () => {
  const browserInputs = [browserInput("chrome", "failure"), browserInput("edge", "failure")];
  const { shouldRun, primary, otherFailedBrowsers } = aggregateBrowserInputs(browserInputs);

  assert.equal(shouldRun, true);
  assert.equal(primary.browser, "chrome");
  assert.deepEqual(otherFailedBrowsers, ["edge"]);

  let analyzeCalls = 0;
  const countingProvider = {
    name: "mock",
    analyze: async () => {
      analyzeCalls += 1;
      return JSON.stringify({
        results: [
          {
            test: { title: primary.context.failedTests[0].title, specFile: primary.context.failedTests[0].specFile },
            classification: "TEST_BUG",
            confidence: 0.9,
            summary: "Summary.",
            rootCause: "Root cause.",
            evidence: ["evidence"],
            recommendedFix: { file: null, description: "Fix it." },
            shouldCreateBug: false,
            shouldRetry: false,
          },
        ],
      });
    },
  };

  const report = await buildFailureReport(primary.context, { provider: countingProvider, history: null });

  assert.equal(analyzeCalls, 1, "provider.analyze() must be called exactly once for a two-browser-failure run");
  assert.deepEqual(validateAnalysisItem(report.results[0], 0), []);
  // Only the primary (chrome) failure was actually analyzed - edge's
  // failure never reached the provider at all, by construction.
  assert.equal(report.sourceContext.browser, "chrome");
});

// --- integration: correlation reaches the actual provider prompt/context (PR #33) ---
// Mirrors exactly what main() does - attach `correlation` onto the primary
// context's own `browserCorrelation` field - then proves that evidence is
// visible to the provider's userPrompt (not just present in the aggregator's
// own return value) while still calling the provider exactly once.

test("integration: multi-browser correlation reaches provider.analyze()'s userPrompt, still exactly one call", async () => {
  const browserInputs = [browserInput("chrome", "failure"), browserInput("edge", "failure")];
  const { primary, correlation } = aggregateBrowserInputs(browserInputs);
  const contextWithCorrelation = { ...primary.context, browserCorrelation: correlation };

  let analyzeCalls = 0;
  let seenUserPrompt = null;
  const countingProvider = {
    name: "mock",
    analyze: async ({ userPrompt }) => {
      analyzeCalls += 1;
      seenUserPrompt = userPrompt;
      return JSON.stringify({
        results: [
          {
            test: { title: contextWithCorrelation.failedTests[0].title, specFile: contextWithCorrelation.failedTests[0].specFile },
            classification: "TEST_BUG",
            confidence: 0.9,
            summary: "Summary.",
            rootCause: "Root cause.",
            evidence: ["evidence"],
            recommendedFix: { file: null, description: "Fix it." },
            shouldCreateBug: false,
            shouldRetry: false,
          },
        ],
      });
    },
  };

  const report = await buildFailureReport(contextWithCorrelation, { provider: countingProvider, history: null });

  assert.equal(analyzeCalls, 1, "provider.analyze() must be called exactly once even with multi-browser correlation attached");
  assert.match(seenUserPrompt, /"primaryBrowser": "chrome"/);
  assert.match(seenUserPrompt, /"failedBrowsers": \[\s*"chrome",\s*"edge"\s*\]/);
  assert.match(seenUserPrompt, /"failureScope": "multi-browser"/);
  // Also preserved on the final report for observability (not just used
  // transiently to build the prompt then discarded).
  assert.deepEqual(report.sourceContext.browserCorrelation, correlation);
});

test("integration: single-browser correlation (one pass, one fail) also reaches the prompt", async () => {
  const browserInputs = [browserInput("chrome", "failure"), browserInput("edge", "success")];
  const { primary, correlation } = aggregateBrowserInputs(browserInputs);
  const contextWithCorrelation = { ...primary.context, browserCorrelation: correlation };

  let seenUserPrompt = null;
  const provider = {
    name: "mock",
    analyze: async ({ userPrompt }) => {
      seenUserPrompt = userPrompt;
      return JSON.stringify({
        results: [
          {
            test: { title: contextWithCorrelation.failedTests[0].title, specFile: contextWithCorrelation.failedTests[0].specFile },
            classification: "TEST_BUG",
            confidence: 0.9,
            summary: "Summary.",
            rootCause: "Root cause.",
            evidence: ["evidence"],
            recommendedFix: { file: null, description: "Fix it." },
            shouldCreateBug: false,
            shouldRetry: false,
          },
        ],
      });
    },
  };

  await buildFailureReport(contextWithCorrelation, { provider, history: null });

  assert.match(seenUserPrompt, /"failureScope": "single-browser"/);
  assert.match(seenUserPrompt, /"passedBrowsers": \[\s*"edge"\s*\]/);
});
