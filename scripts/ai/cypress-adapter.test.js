"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  id,
  collect,
  loadReports,
  walkSuite,
  resolveScreenshotPath,
  extractFailedTests,
  summarizeTestResults,
  truncateText,
} = require("./adapters/cypress-adapter");
const { normalizeSpecPath } = require("./context-utils");
const { validateNormalizedFailure } = require("./normalized-failure");

const ROOT = path.resolve(__dirname, "..", "..");

// --- id ----------------------------------------------------------------

test("id: is exactly the stable lowercase 'cypress' identity", () => {
  assert.equal(id, "cypress");
});

// --- extractFailedTests (moved from collect-context.test.js, Roadmap #19.6B) --

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

// --- extractFailedTests: status semantics edge coverage (Roadmap #19.6B) --

test("extractFailedTests: recognizes the test.fail===true && !test.pending fallback, not just test.state==='failed'", () => {
  const reports = [
    {
      results: [
        {
          file: "/cypress/e2e/tests/x.cy.js",
          suites: [{ title: "Suite", suites: [], tests: [{ title: "fails via fail flag", fail: true, pending: false, err: { message: "m" } }] }],
        },
      ],
    },
  ];
  const failed = extractFailedTests(reports);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].title, "fails via fail flag");
});

test("extractFailedTests: a pending test is never classified as failed, even if fail===true", () => {
  const reports = [
    {
      results: [
        {
          file: "/cypress/e2e/tests/x.cy.js",
          suites: [
            {
              title: "Suite",
              suites: [],
              tests: [
                { title: "pending one", state: "pending" },
                { title: "pending with fail flag", fail: true, pending: true, err: { message: "m" } },
              ],
            },
          ],
        },
      ],
    },
  ];
  const failed = extractFailedTests(reports);
  assert.equal(failed.length, 0);
});

test("extractFailedTests: prefers err.estack, falls back to err.stack when estack is absent", () => {
  const reports = [
    {
      results: [
        {
          file: "/cypress/e2e/tests/x.cy.js",
          suites: [{ title: "Suite", suites: [], tests: [{ title: "fails", state: "failed", err: { message: "m", stack: "plain stack only" } }] }],
        },
      ],
    },
  ];
  const [failed] = extractFailedTests(reports);
  assert.equal(failed.error.stack, "plain stack only");
});

test("extractFailedTests: duration is null when absent or non-numeric", () => {
  const reports = [
    {
      results: [
        {
          file: "/cypress/e2e/tests/x.cy.js",
          suites: [{ title: "Suite", suites: [], tests: [{ title: "fails", state: "failed", err: { message: "m" } }] }],
        },
      ],
    },
  ];
  const [failed] = extractFailedTests(reports);
  assert.equal(failed.duration, null);
});

test("extractFailedTests: aggregates failures across multiple report objects", () => {
  const reports = [
    { results: [{ file: "/a.cy.js", suites: [{ title: "S", suites: [], tests: [{ title: "t1", state: "failed", err: { message: "m1" } }] }] }] },
    { results: [{ file: "/b.cy.js", suites: [{ title: "S", suites: [], tests: [{ title: "t2", state: "failed", err: { message: "m2" } }] }] }] },
  ];
  const failed = extractFailedTests(reports);
  assert.equal(failed.length, 2);
  assert.deepEqual(failed.map((f) => f.specFile).sort(), ["a.cy.js", "b.cy.js"]);
});

test("extractFailedTests: every emitted failure satisfies validateNormalizedFailure()", () => {
  const reports = [
    {
      results: [
        {
          file: "/cypress/e2e/tests/x.cy.js",
          suites: [
            {
              title: "Suite",
              suites: [],
              tests: [
                { title: "fails", state: "failed", duration: 5, err: { message: "m", estack: "s" } },
                { title: "fails via fallback", fail: true, pending: false, err: { message: "m2" } },
              ],
            },
          ],
        },
      ],
    },
  ];
  const failed = extractFailedTests(reports);
  assert.equal(failed.length, 2);
  for (const failure of failed) {
    const result = validateNormalizedFailure(failure);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  }
});

// --- summarizeTestResults (moved from collect-context.test.js) ---------

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

// --- resolveScreenshotPath (moved from collect-context.test.js) --------

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

test("resolveScreenshotPath: an overridden screenshotsDir is honored without touching the real cypress/screenshots directory", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-adapter-screenshots-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const specDir = path.join(tmpRoot, "isolated.cy.js");
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "Suite -- isolated test (failed).png"), "");

  const match = resolveScreenshotPath("cypress/e2e/tests/isolated.cy.js", ["Suite"], "isolated test", tmpRoot);
  assert.equal(match, normalizeSpecPath(path.join(specDir, "Suite -- isolated test (failed).png")));
});

// --- loadReports (moved from collect-context.test.js) ------------------

test("loadReports: reports a clear warning and returns no reports when reports/cypress is missing", (t) => {
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

test("loadReports: an isolated reportsDir with no JSON files warns and returns no reports", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-adapter-reports-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpRoot, "notes.txt"), "not a report");

  const { reports, warnings } = loadReports(tmpRoot);
  assert.equal(reports.length, 0);
  assert.ok(warnings.some((w) => w.includes("contains no JSON report files")));
});

test("loadReports: an isolated reportsDir reads every JSON file when no merged report.json is present", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-adapter-reports-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpRoot, "a.json"), JSON.stringify({ stats: { tests: 1 }, results: [] }));
  fs.writeFileSync(path.join(tmpRoot, "b.json"), JSON.stringify({ stats: { tests: 2 }, results: [] }));

  const { reports, warnings } = loadReports(tmpRoot);
  assert.equal(reports.length, 2);
  assert.deepEqual(warnings, []);
});

test("loadReports: prefers a single merged report.json over per-spec files when present", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-adapter-reports-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmpRoot, "per-spec.json"), JSON.stringify({ stats: { tests: 1 }, results: [] }));
  fs.writeFileSync(path.join(tmpRoot, "report.json"), JSON.stringify({ stats: { tests: 99 }, results: [] }));

  const { reports } = loadReports(tmpRoot);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].stats.tests, 99);
});

// --- collect() (Roadmap #19.6B new thin sequencing entrypoint) ---------

test("collect: with no reports directory returns found:false testResults, empty failedTests, and the discovery warning", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-adapter-collect-"));
  fs.rmSync(tmpRoot, { recursive: true, force: true }); // directory itself must not exist
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const result = collect({ reportsDir: tmpRoot });
  assert.deepEqual(result.testResults, { found: false });
  assert.deepEqual(result.failedTests, []);
  assert.ok(result.warnings.some((w) => w.includes("No report directory")));
});

test("collect: with a real report, returns testResults/failedTests/warnings derived from it", (t) => {
  const tmpReportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-adapter-collect-reports-"));
  const tmpScreenshotsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-adapter-collect-screens-"));
  t.after(() => {
    fs.rmSync(tmpReportsDir, { recursive: true, force: true });
    fs.rmSync(tmpScreenshotsDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(tmpReportsDir, "report.json"),
    JSON.stringify({
      stats: { tests: 1, passes: 0, failures: 1, pending: 0, duration: 10 },
      results: [
        {
          file: "/cypress/e2e/tests/x.cy.js",
          suites: [{ title: "Suite", suites: [], tests: [{ title: "fails", state: "failed", duration: 10, err: { message: "m", estack: "s" } }] }],
        },
      ],
    })
  );

  const result = collect({ reportsDir: tmpReportsDir, screenshotsDir: tmpScreenshotsDir });
  assert.equal(result.testResults.found, true);
  assert.equal(result.testResults.totals.failed, 1);
  assert.equal(result.failedTests.length, 1);
  assert.equal(result.failedTests[0].title, "fails");
  assert.equal(result.failedTests[0].screenshot, null, "no screenshot exists in the isolated screenshotsDir");
  assert.deepEqual(result.warnings, []);
});

// --- walkSuite / truncateText: exercised indirectly above via ----------
// --- extractFailedTests(), matching this repo's existing convention of --
// --- not testing the internal generator/helper separately from its ------
// --- only caller (see collect-context.test.js pre-#19.6B - walkSuite was --
// --- never tested directly either). --------------------------------------
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

test("walkSuite: yields nothing for a null/undefined suite", () => {
  assert.deepEqual([...walkSuite(null, [])], []);
});
