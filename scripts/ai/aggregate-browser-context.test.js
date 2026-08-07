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

function fakeContext(browser) {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    metadata: { repository: "o/r", commit: "abc123", branch: "main", runId: null, event: null, browser, ci: true },
    testResults: { found: true, totals: { tests: 1, passed: 0, failed: 1, pending: 0, duration: 100 }, specs: [] },
    failedTests: [
      {
        title: `${browser} failing test`,
        specFile: "cypress/e2e/tests/example.cy.js",
        suite: "Example",
        status: "failed",
        duration: 500,
        error: { message: "AssertionError: nope", stack: "AssertionError\n  at example.cy.js:1:1" },
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

test("aggregateBrowserInputs: chrome+edge both pass -> shouldRun false, no primary", () => {
  const inputs = [browserInput("chrome", "success"), browserInput("edge", "success")];
  const result = aggregateBrowserInputs(inputs);
  assert.deepEqual(result, { shouldRun: false, primary: null, otherFailedBrowsers: [] });
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
