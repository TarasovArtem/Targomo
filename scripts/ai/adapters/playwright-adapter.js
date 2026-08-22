#!/usr/bin/env node
/**
 * Playwright Adapter (Roadmap #19.8B - offline only)
 *
 * Normalizes Playwright's official JSON reporter output into this
 * repository's existing generic collection contract - the same
 * { testResults, failedTests, warnings } shape produced by
 * scripts/ai/adapters/cypress-adapter.js - so the generic collector/AI
 * pipeline never needs to know which framework produced the evidence.
 *
 * OFFLINE ONLY (Roadmap #19.8B): this file is not wired into
 * collect-context.js's production runtime, which still imports and calls
 * only the Cypress adapter (see scripts/ai/collect-context.js). This
 * module and its tests prove that an official JSON-reporter-shaped report
 * can be normalized through the same generic contract as Cypress -
 * nothing more. No Playwright package is installed or required to parse
 * these fixtures; the shape here is modeled from Playwright's documented
 * JSONReport/JSONReportSuite/JSONReportSpec/JSONReportTest/
 * JSONReportTestResult/JSONReportAttachment fields, not verified against
 * an installed package or a real captured report (see #19.8A/#19.8B
 * roadmap notes for the exact compatibility-claim boundary).
 *
 * CRITICAL logical-outcome rule (the reason this file exists in its
 * current form rather than a naive "last result wins" implementation):
 * Playwright's authoritative LOGICAL outcome for one test is
 * JSONReportTest.status ("expected" | "unexpected" | "flaky" | "skipped"),
 * which is distinct from JSONReportTestResult.status on an individual
 * attempt ("passed" | "failed" | "timedOut" | "skipped" | "interrupted").
 * A test can have expectedStatus: "failed" and a final attempt status of
 * "failed" while test.status is still "expected" (e.g. test.fail() -
 * an assertion that is SUPPOSED to fail) - that must never surface as a
 * generic failure. Likewise a "flaky" test (failed, then passed on
 * retry) must never surface as a generic failure just because an earlier
 * attempt failed. Only test.status === "unexpected" produces a
 * failedTests entry, and exactly one per logical test, built from the
 * FINAL (last) result as primary evidence.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeSpecPath } = require("../context-utils");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_REPORT_FILE = path.join(ROOT, "reports", "playwright", "report.json");

// Roadmap #19.8A/#19.8B: this adapter's own stable, canonical,
// machine-readable identity - never inferred, always this constant.
const id = "playwright";

function loadReport(reportFile = DEFAULT_REPORT_FILE) {
  const warnings = [];

  if (!fs.existsSync(reportFile)) {
    // Fixed canonical-path text, not the actual (possibly overridden/temp)
    // reportFile argument - matches cypress-adapter.js's loadReports()
    // convention of never leaking an overridden/temp path into a warning
    // string (see its "No report directory found at reports/cypress."
    // message, which is identical regardless of the reportsDir argument).
    warnings.push(
      `No Playwright JSON report found at reports/playwright/report.json. Run a Playwright test script before ai:collect.`
    );
    return { report: null, warnings };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } catch (err) {
    warnings.push(`Could not parse reports/playwright/report.json: ${err.message}`);
    return { report: null, warnings };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.suites)) {
    warnings.push(`reports/playwright/report.json has an unexpected shape (missing a top-level "suites" array).`);
    return { report: null, warnings };
  }

  return { report: parsed, warnings };
}

// Recursively walks the official suites[]/suites[].suites[] hierarchy,
// yielding one entry per spec with its resolved describe-block ancestry
// (suiteTitles) and resolved spec file. The top-level suite in
// report.suites[] represents a *file*, not a describe block - its own
// title is deliberately never folded into suiteTitles (see buildFailure's
// fullTitle construction), only nested suite.suites[] entries are.
function walkReportSuites(suites) {
  const entries = [];
  for (const fileSuite of Array.isArray(suites) ? suites : []) {
    if (!fileSuite || typeof fileSuite !== "object") continue;
    const fileHint = typeof fileSuite.file === "string" && fileSuite.file ? fileSuite.file : null;
    walkGroup(fileSuite, [], fileHint, entries);
  }
  return entries;
}

function walkGroup(suite, ancestorTitles, fileHint, entries) {
  for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
    if (!spec || typeof spec !== "object") continue;
    // Roadmap #19.8B Phase 9: spec.file is preferred; the nearest
    // enclosing suite's file is only a fallback, never duplicated
    // normalization logic - normalizeSpecPath() (context-utils.js) is
    // reused unchanged, exactly as the Cypress adapter does.
    const specFileRaw = (typeof spec.file === "string" && spec.file) || fileHint || null;
    entries.push({ spec, suiteTitles: ancestorTitles, specFile: normalizeSpecPath(specFileRaw) });
  }
  for (const child of Array.isArray(suite.suites) ? suite.suites : []) {
    if (!child || typeof child !== "object") continue;
    const childFileHint = (typeof child.file === "string" && child.file) || fileHint;
    const childTitles = typeof child.title === "string" && child.title ? [...ancestorTitles, child.title] : ancestorTitles;
    walkGroup(child, childTitles, childFileHint, entries);
  }
}

// The single authoritative mapping from Playwright's LOGICAL test.status
// to this repository's generic pass/fail/pending vocabulary. Never reads
// an individual result's status - see the module docstring.
function classifyTestStatus(status) {
  if (status === "expected" || status === "flaky") return "passed";
  if (status === "unexpected") return "failed";
  if (status === "skipped") return "pending";
  return "unknown";
}

// The FINAL attempt is the only one ever used as normalized evidence
// (duration/error/attachments) - one logical test always yields at most
// one normalized failure, never one per retry attempt.
function selectPrimaryResult(test) {
  const results = Array.isArray(test.results) ? test.results : [];
  return results.length > 0 ? results[results.length - 1] : null;
}

// Prefers result.error (Playwright's own "first test error" field);
// falls back to result.errors[0] only when structurally valid. Never
// concatenates multiple errors into one synthetic message/stack.
function buildFailureError(primary) {
  if (!primary) return { message: null, stack: null };

  const source =
    primary.error && typeof primary.error === "object"
      ? primary.error
      : Array.isArray(primary.errors) && primary.errors.length > 0 && primary.errors[0] && typeof primary.errors[0] === "object"
        ? primary.errors[0]
        : null;

  return {
    message: source && typeof source.message === "string" ? source.message : null,
    stack: source && typeof source.stack === "string" ? source.stack : null,
  };
}

// Screenshot mapping is entirely adapter-local (Roadmap #19.8A Phase 15):
// only the PRIMARY (final) result's attachments are ever inspected, only
// an attachment explicitly named "screenshot" ever qualifies, and among
// several such attachments the last one wins deterministically. A
// body-only attachment (no `path`) never becomes a screenshot - #19.8B
// does not write attachment bodies to disk. Existence on disk is verified
// exactly like the Cypress adapter verifies its own screenshot
// candidates, so a stale/incorrect path never silently becomes a lie.
function resolveScreenshot(primary, title, warnings) {
  if (!primary || !Array.isArray(primary.attachments)) return null;

  const screenshotAttachments = primary.attachments.filter(
    (a) => a && typeof a === "object" && a.name === "screenshot"
  );
  if (screenshotAttachments.length === 0) return null;

  const chosen = screenshotAttachments[screenshotAttachments.length - 1];

  if (typeof chosen.path === "string" && chosen.path) {
    if (fs.existsSync(chosen.path)) {
      return normalizeSpecPath(chosen.path);
    }
    // Never interpolates the actual (possibly absolute/temp) path into
    // the warning string - only the test title, matching the
    // no-absolute-temp-paths-in-warnings policy.
    warnings.push(`Screenshot attachment path for test "${title || "(untitled)"}" does not exist on disk.`);
    return null;
  }

  warnings.push(`Screenshot attachment for test "${title || "(untitled)"}" has no usable path.`);
  return null;
}

// Mirrors cypress-adapter.js's summarizeTestResults() shape exactly:
// { found, totals: {tests,passed,failed,pending,duration}, specs: [...] }.
// found is always true here - this function is only ever called once a
// report has already loaded successfully (see collect()); an empty
// suites[] array (or a report with zero logical tests) still yields
// found:true with all-zero totals, exactly like the Cypress adapter
// treats a successfully parsed report with zero results.
function summarizeTestResults(entries, warnings) {
  const specStats = new Map();
  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalPending = 0;
  let totalDuration = 0;

  for (const { spec, specFile } of entries) {
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.tests)) {
      warnings.push(`Skipped a malformed spec entry (missing a "tests" array)${spec && typeof spec.title === "string" ? ` for "${spec.title}"` : ""}.`);
      continue;
    }

    for (const test of spec.tests) {
      if (!test || typeof test !== "object" || typeof test.status !== "string") {
        warnings.push(`Skipped a malformed test entry under spec "${spec.title || "(untitled)"}".`);
        continue;
      }

      const bucket = classifyTestStatus(test.status);
      if (bucket === "unknown") {
        warnings.push(
          `Unknown Playwright test.status "${test.status}" for test "${spec.title || "(untitled)"}"; treated conservatively as neither pass nor fail.`
        );
      }

      const primary = selectPrimaryResult(test);
      const duration = primary && Number.isFinite(primary.duration) ? primary.duration : 0;

      totalTests += 1;
      if (bucket === "passed") totalPassed += 1;
      else if (bucket === "failed") totalFailed += 1;
      else if (bucket === "pending") totalPending += 1;
      totalDuration += duration;

      if (specFile) {
        if (!specStats.has(specFile)) specStats.set(specFile, { tests: 0, passed: 0, failed: 0, pending: 0, duration: 0 });
        const s = specStats.get(specFile);
        s.tests += 1;
        if (bucket === "passed") s.passed += 1;
        else if (bucket === "failed") s.failed += 1;
        else if (bucket === "pending") s.pending += 1;
        s.duration += duration;
      }
    }
  }

  return {
    found: true,
    totals: { tests: totalTests, passed: totalPassed, failed: totalFailed, pending: totalPending, duration: totalDuration },
    specs: [...specStats.entries()].map(([specFile, s]) => ({ specFile, ...s })),
  };
}

// Emits exactly one normalized failure per logical test whose
// test.status === "unexpected" - never per retry attempt (Roadmap #19.8B
// Phase 13/14). Every emitted object satisfies
// scripts/ai/normalized-failure.js's validateNormalizedFailure() contract
// unchanged; projectId/projectName are preserved as allowed extra fields
// (Roadmap #19.8B Phase 19), never required by the generic validator.
function extractFailedTests(entries, warnings) {
  const failedTests = [];

  for (const { spec, suiteTitles, specFile } of entries) {
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.tests)) continue; // already warned in summarizeTestResults
    for (const test of spec.tests) {
      if (!test || typeof test !== "object" || typeof test.status !== "string") continue; // already warned
      if (classifyTestStatus(test.status) !== "failed") continue;

      const primary = selectPrimaryResult(test);
      if (!primary) {
        warnings.push(
          `Test "${typeof spec.title === "string" ? spec.title : "(untitled)"}" is unexpected (failed) but has no result entries; error evidence unavailable.`
        );
      }

      const title = typeof spec.title === "string" ? spec.title : null;
      const fullTitle = title ? (suiteTitles.length > 0 ? [...suiteTitles, title].join(" > ") : title) : null;
      const duration = primary && Number.isFinite(primary.duration) ? primary.duration : null;

      const failure = {
        title,
        fullTitle,
        specFile,
        suite: suiteTitles.join(" > ") || null,
        status: "failed",
        duration,
        error: buildFailureError(primary),
        screenshot: resolveScreenshot(primary, title, warnings),
      };
      if (typeof test.projectId === "string" && test.projectId) failure.projectId = test.projectId;
      if (typeof test.projectName === "string" && test.projectName) failure.projectName = test.projectName;

      failedTests.push(failure);
    }
  }

  return failedTests;
}

// Roadmap #19.8B: thin synchronous sequencing entrypoint, mirroring
// cypress-adapter.js's own collect(). Framework-specific INPUT
// (reportFile, a single JSON report path) is intentionally different
// from Cypress's reportsDir/screenshotsDir - the generic OUTPUT contract
// is identical.
function collect({ reportFile = DEFAULT_REPORT_FILE } = {}) {
  const { report, warnings } = loadReport(reportFile);

  if (!report) {
    return { testResults: { found: false }, failedTests: [], warnings };
  }

  const entries = walkReportSuites(report.suites);
  const testResults = summarizeTestResults(entries, warnings);
  const failedTests = extractFailedTests(entries, warnings);

  // Top-level errors[] are not attached to any individual test (e.g. a
  // global setup failure) - never fabricated into a fake failedTests
  // entry; only a deterministic, count-only warning, never raw stacks.
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    warnings.push(`Playwright report contains ${report.errors.length} top-level error(s) not attached to any individual test.`);
  }

  return { testResults, failedTests, warnings };
}

module.exports = {
  id,
  collect,
  loadReport,
  walkReportSuites,
  classifyTestStatus,
  selectPrimaryResult,
  summarizeTestResults,
  extractFailedTests,
  DEFAULT_REPORT_FILE,
};
