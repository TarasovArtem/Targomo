"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  id,
  collect,
  loadReport,
  walkReportSuites,
  classifyTestStatus,
  selectPrimaryResult,
  summarizeTestResults,
  extractFailedTests,
  DEFAULT_REPORT_FILE,
} = require("./adapters/playwright-adapter");
const { normalizeSpecPath } = require("./context-utils");
const { validateNormalizedFailure } = require("./normalized-failure");

const ROOT = path.resolve(__dirname, "..", "..");

// --- fixture builders (official JSON-reporter-shaped, Roadmap #19.8B) -----
// Modeled from Playwright's documented JSONReport*/attachment fields (see
// playwright-adapter.js's module docstring for the exact compatibility
// caveat) - inline literals, matching this repository's existing
// convention (cypress-adapter.test.js/cypress-equivalence.test.js also
// build fixtures as inline JS objects, never external fixture files).

function report({ suites = [], errors = [] } = {}) {
  return { config: {}, suites, errors, stats: {} };
}

function fileSuite({ title, file, specs = [], suites = [] }) {
  return { title, file, line: 1, column: 1, specs, suites };
}

function describeSuite({ title, file = null, specs = [], suites = [] }) {
  return { title, file, specs, suites };
}

function spec({ title, file, tests }) {
  return { title, ok: tests.every((t) => t.status !== "unexpected"), tags: [], id: `id-${title}`, file, line: 1, column: 1, tests };
}

function logicalTest({ status, expectedStatus = "passed", projectId, projectName, results = [] }) {
  const t = { timeout: 30000, annotations: [], expectedStatus, status, results };
  if (projectId) t.projectId = projectId;
  if (projectName) t.projectName = projectName;
  return t;
}

function result({ status, duration = 0, error, errors, attachments = [], retry = 0 }) {
  const r = {
    workerIndex: 0,
    parallelIndex: 0,
    status,
    duration,
    retry,
    steps: [],
    startTime: "2026-01-01T00:00:00.000Z",
    annotations: [],
    attachments,
  };
  if (error) r.error = error;
  if (errors) r.errors = errors;
  return r;
}

function writeReportFixture(t, reportObj) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-adapter-report-"));
  const reportFile = path.join(tmpDir, "report.json");
  fs.writeFileSync(reportFile, JSON.stringify(reportObj));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  return reportFile;
}

// --- id --------------------------------------------------------------------

test("id: is exactly the stable lowercase 'playwright' identity", () => {
  assert.equal(id, "playwright");
});

test("DEFAULT_REPORT_FILE: points at the canonical reports/playwright/report.json path", () => {
  assert.equal(DEFAULT_REPORT_FILE, path.join(ROOT, "reports", "playwright", "report.json"));
});

// --- classifyTestStatus (pure) ----------------------------------------------

test("classifyTestStatus: expected and flaky both map to passed", () => {
  assert.equal(classifyTestStatus("expected"), "passed");
  assert.equal(classifyTestStatus("flaky"), "passed");
});

test("classifyTestStatus: unexpected maps to failed", () => {
  assert.equal(classifyTestStatus("unexpected"), "failed");
});

test("classifyTestStatus: skipped maps to pending", () => {
  assert.equal(classifyTestStatus("skipped"), "pending");
});

test("classifyTestStatus: an unrecognized value maps to unknown, never silently to failed", () => {
  assert.equal(classifyTestStatus("something-else"), "unknown");
  assert.equal(classifyTestStatus(undefined), "unknown");
});

// --- selectPrimaryResult (pure) ---------------------------------------------

test("selectPrimaryResult: returns the LAST result, not the first, when multiple attempts exist", () => {
  const t = logicalTest({
    status: "flaky",
    results: [result({ status: "failed", duration: 1 }), result({ status: "passed", duration: 2 })],
  });
  assert.equal(selectPrimaryResult(t).duration, 2);
});

test("selectPrimaryResult: returns null when results is empty", () => {
  assert.equal(selectPrimaryResult(logicalTest({ status: "unexpected", results: [] })), null);
});

// --- P1: single expected/pass -----------------------------------------------

test("P1 single expected/pass: not in failedTests, counted as passed", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p1.spec.ts",
          file: "tests/p1.spec.ts",
          specs: [
            spec({
              title: "loads the homepage",
              file: "tests/p1.spec.ts",
              tests: [logicalTest({ status: "expected", results: [result({ status: "passed", duration: 120 })] })],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.deepEqual(out.failedTests, []);
  assert.equal(out.testResults.found, true);
  assert.deepEqual(out.testResults.totals, { tests: 1, passed: 1, failed: 0, pending: 0, duration: 120 });
  assert.deepEqual(out.warnings, []);
});

// --- P2: single unexpected/failure ------------------------------------------

test("P2 single unexpected/failure: exactly one failedTests entry with error/duration from the result", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p2.spec.ts",
          file: "tests/p2.spec.ts",
          specs: [
            spec({
              title: "renders results",
              file: "tests/p2.spec.ts",
              tests: [
                logicalTest({
                  status: "unexpected",
                  expectedStatus: "passed",
                  results: [
                    result({
                      status: "failed",
                      duration: 340,
                      error: { message: "Timed out waiting for selector", stack: "Error: Timed out\n  at x" },
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests.length, 1);
  const [f] = out.failedTests;
  assert.equal(f.title, "renders results");
  assert.equal(f.fullTitle, "renders results");
  assert.equal(f.specFile, "tests/p2.spec.ts");
  assert.equal(f.duration, 340);
  assert.deepEqual(f.error, { message: "Timed out waiting for selector", stack: "Error: Timed out\n  at x" });
  assert.equal(f.screenshot, null);
  assert.deepEqual(validateNormalizedFailure(f).errors, []);
});

// --- P3: nested suites / fullTitle -------------------------------------------

test("P3 nested suites: fullTitle joins describe ancestry (excluding the top-level file suite) with ' > '", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p3.spec.ts",
          file: "tests/p3.spec.ts",
          suites: [
            describeSuite({
              title: "Results page",
              specs: [
                spec({
                  title: "shows results",
                  file: "tests/p3.spec.ts",
                  tests: [logicalTest({ status: "unexpected", results: [result({ status: "failed", duration: 10 })] })],
                }),
              ],
              suites: [
                describeSuite({
                  title: "Filters",
                  specs: [
                    spec({
                      title: "applies a filter",
                      file: "tests/p3.spec.ts",
                      tests: [logicalTest({ status: "unexpected", results: [result({ status: "failed", duration: 11 })] })],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests.length, 2);
  assert.equal(out.failedTests[0].fullTitle, "Results page > shows results");
  assert.equal(out.failedTests[0].suite, "Results page");
  assert.equal(out.failedTests[1].fullTitle, "Results page > Filters > applies a filter");
  assert.equal(out.failedTests[1].suite, "Results page > Filters");
});

// --- P4: mixed expected/unexpected -------------------------------------------

test("P4 mixed pass/fail: totals split correctly, failedTests contains only the unexpected one", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p4.spec.ts",
          file: "tests/p4.spec.ts",
          specs: [
            spec({
              title: "a passes",
              file: "tests/p4.spec.ts",
              tests: [logicalTest({ status: "expected", results: [result({ status: "passed", duration: 5 })] })],
            }),
            spec({
              title: "b fails",
              file: "tests/p4.spec.ts",
              tests: [logicalTest({ status: "unexpected", results: [result({ status: "failed", duration: 6 })] })],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.deepEqual(out.testResults.totals, { tests: 2, passed: 1, failed: 1, pending: 0, duration: 11 });
  assert.equal(out.failedTests.length, 1);
  assert.equal(out.failedTests[0].title, "b fails");
});

// --- P5: skipped ---------------------------------------------------------------

test("P5 skipped: counted as pending, never in failedTests", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p5.spec.ts",
          file: "tests/p5.spec.ts",
          specs: [
            spec({
              title: "not run on this project",
              file: "tests/p5.spec.ts",
              tests: [logicalTest({ status: "skipped", expectedStatus: "skipped", results: [] })],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.deepEqual(out.testResults.totals, { tests: 1, passed: 0, failed: 0, pending: 1, duration: 0 });
  assert.deepEqual(out.failedTests, []);
});

// --- P6: duration is milliseconds, passed through unmodified -----------------

test("P6 duration: passed through unchanged (ms), and totals sum per-spec exactly", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p6.spec.ts",
          file: "tests/p6.spec.ts",
          specs: [
            spec({
              title: "a",
              file: "tests/p6.spec.ts",
              tests: [logicalTest({ status: "expected", results: [result({ status: "passed", duration: 1234 })] })],
            }),
            spec({
              title: "b",
              file: "tests/p6.spec.ts",
              tests: [logicalTest({ status: "unexpected", results: [result({ status: "failed", duration: 4567 })] })],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests[0].duration, 4567);
  assert.equal(out.testResults.totals.duration, 1234 + 4567);
  assert.deepEqual(out.testResults.specs, [{ specFile: "tests/p6.spec.ts", tests: 2, passed: 1, failed: 1, pending: 0, duration: 5801 }]);
});

// --- P7: single screenshot attachment -----------------------------------------

test("P7 single screenshot attachment: normalized path returned when the file exists on disk", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-adapter-screenshot-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const screenshotPath = path.join(tmpDir, "shot.png");
  fs.writeFileSync(screenshotPath, "");

  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p7.spec.ts",
          file: "tests/p7.spec.ts",
          specs: [
            spec({
              title: "fails with a screenshot",
              file: "tests/p7.spec.ts",
              tests: [
                logicalTest({
                  status: "unexpected",
                  results: [
                    result({
                      status: "failed",
                      duration: 10,
                      attachments: [{ name: "screenshot", contentType: "image/png", path: screenshotPath }],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests[0].screenshot, normalizeSpecPath(screenshotPath));
});

// --- P8: multiple attachments, deterministic screenshot selection ------------

test("P8 multiple attachments: only name==='screenshot' qualifies, and the LAST such attachment wins deterministically", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-adapter-attachments-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const shotA = path.join(tmpDir, "a.png");
  const shotB = path.join(tmpDir, "b.png");
  fs.writeFileSync(shotA, "");
  fs.writeFileSync(shotB, "");

  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p8.spec.ts",
          file: "tests/p8.spec.ts",
          specs: [
            spec({
              title: "fails with several attachments",
              file: "tests/p8.spec.ts",
              tests: [
                logicalTest({
                  status: "unexpected",
                  results: [
                    result({
                      status: "failed",
                      duration: 10,
                      attachments: [
                        { name: "video", contentType: "video/webm", path: path.join(tmpDir, "v.webm") },
                        { name: "screenshot", contentType: "image/png", path: shotA },
                        { name: "trace", contentType: "application/zip", path: path.join(tmpDir, "trace.zip") },
                        { name: "screenshot", contentType: "image/png", path: shotB },
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests[0].screenshot, normalizeSpecPath(shotB));
});

// --- P9: screenshot metadata without a usable path ----------------------------

test("P9 screenshot metadata without a usable path: null + warning, never a fabricated path", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p9.spec.ts",
          file: "tests/p9.spec.ts",
          specs: [
            spec({
              title: "fails with a body-only screenshot",
              file: "tests/p9.spec.ts",
              tests: [
                logicalTest({
                  status: "unexpected",
                  results: [
                    result({
                      status: "failed",
                      duration: 10,
                      attachments: [{ name: "screenshot", contentType: "image/png", body: "base64==" }],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests[0].screenshot, null);
  assert.ok(out.warnings.some((w) => w.includes("no usable path")));
});

test("P9b screenshot path that does not exist on disk: null + warning, path itself never leaked into the warning", (t) => {
  const missingPath = path.join(os.tmpdir(), "playwright-adapter-does-not-exist", "shot.png");

  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p9b.spec.ts",
          file: "tests/p9b.spec.ts",
          specs: [
            spec({
              title: "fails with a stale screenshot path",
              file: "tests/p9b.spec.ts",
              tests: [
                logicalTest({
                  status: "unexpected",
                  results: [result({ status: "failed", duration: 10, attachments: [{ name: "screenshot", contentType: "image/png", path: missingPath }] })],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests[0].screenshot, null);
  assert.ok(out.warnings.some((w) => w.includes("does not exist on disk")));
  assert.ok(!out.warnings.some((w) => w.includes(missingPath)), "the absolute temp path must never appear in a warning string");
});

// --- P10: malformed JSON --------------------------------------------------------

test("P10 malformed JSON: found:false, empty failedTests, one deterministic warning, never throws", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-adapter-report-"));
  const reportFile = path.join(tmpDir, "report.json");
  fs.writeFileSync(reportFile, "{ not valid json");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const out = collect({ reportFile });
  assert.deepEqual(out.testResults, { found: false });
  assert.deepEqual(out.failedTests, []);
  assert.ok(out.warnings.some((w) => w.includes("Could not parse")));
});

// --- P11: empty/no suites report -------------------------------------------------

test("P11 empty report (valid JSON, suites:[]): found:true with all-zero totals, not found:false", (t) => {
  const reportFile = writeReportFixture(t, report({ suites: [] }));

  const out = collect({ reportFile });
  assert.deepEqual(out.testResults, { found: true, totals: { tests: 0, passed: 0, failed: 0, pending: 0, duration: 0 }, specs: [] });
  assert.deepEqual(out.failedTests, []);
  assert.deepEqual(out.warnings, []);
});

test("missing report file: found:false with a deterministic 'no report' warning", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-adapter-missing-"));
  const reportFile = path.join(tmpDir, "report.json");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const out = collect({ reportFile });
  assert.deepEqual(out.testResults, { found: false });
  assert.deepEqual(out.failedTests, []);
  assert.ok(out.warnings.some((w) => w.includes("No Playwright JSON report found")));
});

// --- P12: flaky (failed attempt -> passed attempt) -------------------------------

test("P12 flaky: excluded from failedTests, counted as passed, exactly one logical test (not two)", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p12.spec.ts",
          file: "tests/p12.spec.ts",
          specs: [
            spec({
              title: "eventually passes",
              file: "tests/p12.spec.ts",
              tests: [
                logicalTest({
                  status: "flaky",
                  results: [
                    result({ status: "failed", duration: 200, error: { message: "flaky assertion", stack: "at x" } }),
                    result({ status: "passed", duration: 150 }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.deepEqual(out.failedTests, []);
  assert.deepEqual(out.testResults.totals, { tests: 1, passed: 1, failed: 0, pending: 0, duration: 150 });
});

// --- P13: unexpected, all retries failed -----------------------------------------

test("P13 unexpected with all retries failed: exactly one failedTests entry, built from the FINAL attempt", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p13.spec.ts",
          file: "tests/p13.spec.ts",
          specs: [
            spec({
              title: "never passes",
              file: "tests/p13.spec.ts",
              tests: [
                logicalTest({
                  status: "unexpected",
                  results: [
                    result({ status: "failed", duration: 50, retry: 0, error: { message: "first attempt error", stack: "s1" } }),
                    result({ status: "failed", duration: 60, retry: 1, error: { message: "final attempt error", stack: "s2" } }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests.length, 1);
  assert.equal(out.failedTests[0].duration, 60);
  assert.equal(out.failedTests[0].error.message, "final attempt error");
});

// --- P14: multiple errors, deterministic primary ----------------------------------

test("P14 multiple errors on one result: uses errors[0] deterministically, never concatenates", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p14.spec.ts",
          file: "tests/p14.spec.ts",
          specs: [
            spec({
              title: "fails with multiple errors",
              file: "tests/p14.spec.ts",
              tests: [
                logicalTest({
                  status: "unexpected",
                  results: [
                    result({
                      status: "failed",
                      duration: 20,
                      errors: [
                        { message: "first error", stack: "stack1" },
                        { message: "second error", stack: "stack2" },
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.deepEqual(out.failedTests[0].error, { message: "first error", stack: "stack1" });
});

// --- P15: path normalization -------------------------------------------------------

test("P15 path normalization: an absolute under-ROOT spec.file normalizes to a repo-relative forward-slash path", (t) => {
  const absoluteSpecFile = path.join(ROOT, "tests", "p15.spec.ts");

  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p15.spec.ts",
          file: absoluteSpecFile,
          specs: [
            spec({
              title: "uses an absolute path",
              file: absoluteSpecFile,
              tests: [logicalTest({ status: "expected", results: [result({ status: "passed", duration: 1 })] })],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.testResults.specs[0].specFile, "tests/p15.spec.ts");
});

// --- P16: EXPECTED FAILURE (mandatory regression protection) ----------------------

test("P16 EXPECTED FAILURE: expectedStatus=failed + result.status=failed + test.status=expected must NOT appear in failedTests", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p16.spec.ts",
          file: "tests/p16.spec.ts",
          specs: [
            spec({
              title: "asserts an intentional failure via test.fail()",
              file: "tests/p16.spec.ts",
              tests: [
                logicalTest({
                  status: "expected",
                  expectedStatus: "failed",
                  results: [result({ status: "failed", duration: 50, error: { message: "expected failure", stack: "at intentional" } })],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.deepEqual(out.failedTests, [], "an expected failure must never surface as a generic failedTests entry");
  assert.deepEqual(out.testResults.totals, { tests: 1, passed: 1, failed: 0, pending: 0, duration: 50 }, "must be counted as a logical success");
});

// --- P17: multi-project ------------------------------------------------------------

test("P17 multi-project: each JSONReportTest entry is a separate logical execution instance; only the unexpected one fails", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p17.spec.ts",
          file: "tests/p17.spec.ts",
          specs: [
            spec({
              title: "cross-project test",
              file: "tests/p17.spec.ts",
              tests: [
                logicalTest({
                  status: "unexpected",
                  projectId: "chromium",
                  projectName: "chromium",
                  results: [result({ status: "failed", duration: 30, error: { message: "chromium-only failure", stack: "s" } })],
                }),
                logicalTest({
                  status: "expected",
                  projectId: "firefox",
                  projectName: "firefox",
                  results: [result({ status: "passed", duration: 25 })],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.testResults.totals.tests, 2);
  assert.equal(out.testResults.totals.failed, 1);
  assert.equal(out.testResults.totals.passed, 1);
  assert.equal(out.failedTests.length, 1);
  assert.equal(out.failedTests[0].projectName, "chromium");
  assert.equal(out.failedTests[0].projectId, "chromium");
});

// --- P18: unknown logical test status ------------------------------------------

test("P18 unknown test.status: excluded from passed/failed/pending, excluded from failedTests, warns", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p18.spec.ts",
          file: "tests/p18.spec.ts",
          specs: [
            spec({
              title: "has an unrecognized status",
              file: "tests/p18.spec.ts",
              tests: [logicalTest({ status: "somethingElse", results: [result({ status: "passed", duration: 5 })] })],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.deepEqual(out.failedTests, []);
  assert.deepEqual(out.testResults.totals, { tests: 1, passed: 0, failed: 0, pending: 0, duration: 5 });
  assert.ok(out.warnings.some((w) => w.includes('Unknown Playwright test.status "somethingElse"')));
});

// --- P19: top-level global errors -------------------------------------------------

test("P19 top-level global errors: deterministic count-only warning, never fabricated as a failedTests entry", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "p19.spec.ts",
          file: "tests/p19.spec.ts",
          specs: [
            spec({
              title: "runs fine",
              file: "tests/p19.spec.ts",
              tests: [logicalTest({ status: "expected", results: [result({ status: "passed", duration: 5 })] })],
            }),
          ],
        }),
      ],
      errors: [{ message: "Global setup failed: could not start server", stack: "at globalSetup" }],
    })
  );

  const out = collect({ reportFile });
  assert.deepEqual(out.failedTests, []);
  assert.ok(out.warnings.some((w) => w.includes("1 top-level error")));
  assert.ok(!out.warnings.some((w) => w.includes("at globalSetup")), "raw global-error stacks must never be copied into a warning");
});

// --- structural robustness (Phase 5: schema guard, malformed local entries) -----

test("malformed spec entry (missing tests array) is skipped with a warning, other evidence in the same report survives", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "mixed.spec.ts",
          file: "tests/mixed.spec.ts",
          specs: [
            { title: "broken spec", file: "tests/mixed.spec.ts" }, // no tests[] at all
            spec({
              title: "healthy spec",
              file: "tests/mixed.spec.ts",
              tests: [logicalTest({ status: "expected", results: [result({ status: "passed", duration: 1 })] })],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.testResults.totals.tests, 1);
  assert.ok(out.warnings.some((w) => w.includes("malformed spec entry")));
});

test("an unexpected test with zero result entries still normalizes with null error/duration and a warning, never throws", (t) => {
  const reportFile = writeReportFixture(
    t,
    report({
      suites: [
        fileSuite({
          title: "empty-results.spec.ts",
          file: "tests/empty-results.spec.ts",
          specs: [
            spec({
              title: "unexpected with no results",
              file: "tests/empty-results.spec.ts",
              tests: [logicalTest({ status: "unexpected", results: [] })],
            }),
          ],
        }),
      ],
    })
  );

  const out = collect({ reportFile });
  assert.equal(out.failedTests.length, 1);
  assert.equal(out.failedTests[0].duration, null);
  assert.deepEqual(out.failedTests[0].error, { message: null, stack: null });
  assert.ok(out.warnings.some((w) => w.includes("no result entries")));
});

// --- normalized-failure contract compliance (Phase 26) ---------------------------

test("every emitted failedTests entry across every fixture in this file satisfies validateNormalizedFailure()", (t) => {
  const scenarios = [
    report({
      suites: [
        fileSuite({
          title: "all.spec.ts",
          file: "tests/all.spec.ts",
          specs: [
            spec({
              title: "fails plainly",
              file: "tests/all.spec.ts",
              tests: [logicalTest({ status: "unexpected", results: [result({ status: "failed", duration: 1, error: { message: "m", stack: "s" } })] })],
            }),
            spec({
              title: "fails with no results",
              file: "tests/all.spec.ts",
              tests: [logicalTest({ status: "unexpected", results: [] })],
            }),
          ],
        }),
      ],
    }),
  ];

  for (const reportObj of scenarios) {
    const reportFile = writeReportFixture(t, reportObj);
    const out = collect({ reportFile });
    assert.ok(out.failedTests.length > 0);
    for (const failure of out.failedTests) {
      const result_ = validateNormalizedFailure(failure);
      assert.deepEqual(result_.errors, [], `failure "${failure.title}" must satisfy the normalized-failure contract`);
      assert.equal(result_.valid, true);
    }
  }
});

// --- walkReportSuites / loadReport unit-level coverage ---------------------------

test("walkReportSuites: the top-level file-suite's own title is never folded into suiteTitles", () => {
  const entries = walkReportSuites([
    fileSuite({
      title: "should-not-appear.spec.ts",
      file: "tests/x.spec.ts",
      specs: [spec({ title: "leaf", file: "tests/x.spec.ts", tests: [] })],
    }),
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].suiteTitles, []);
});

test("loadReport: a missing file returns null report and a deterministic warning", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-adapter-loadreport-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const { report: r, warnings } = loadReport(path.join(tmpDir, "does-not-exist.json"));
  assert.equal(r, null);
  assert.ok(warnings.some((w) => w.includes("No Playwright JSON report found")));
});

test("loadReport: a top-level shape without a suites array is rejected with a warning, not thrown", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-adapter-loadreport-"));
  const reportFile = path.join(tmpDir, "report.json");
  fs.writeFileSync(reportFile, JSON.stringify({ config: {}, stats: {} }));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { report: r, warnings } = loadReport(reportFile);
  assert.equal(r, null);
  assert.ok(warnings.some((w) => w.includes("unexpected shape")));
});

// --- default-path wiring (real, but always-absent, canonical path) ---------------

test("collect(): with no argument, uses DEFAULT_REPORT_FILE and returns found:false since no real Playwright report exists in this repository", () => {
  const out = collect();
  assert.deepEqual(out.testResults, { found: false });
  assert.deepEqual(out.failedTests, []);
  assert.ok(out.warnings.some((w) => w.includes("No Playwright JSON report found")));
});
