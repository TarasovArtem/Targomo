#!/usr/bin/env node
/**
 * Cypress Adapter (Roadmap #19.6B)
 *
 * Owns everything specific to this repository's current test framework:
 * discovering and parsing the mochawesome JSON report(s) produced by
 * `cypress run` (see reporterOptions in cypress.config.js), and matching
 * Cypress's own on-failure screenshot naming convention. Nothing outside
 * this file needs to know a mochawesome report's shape, Cypress's
 * screenshot filename convention, or any other raw Cypress artifact
 * detail - the generic collector (scripts/ai/collect-context.js) only
 * ever consumes this adapter's normalized `collect()` result.
 *
 * This is a behavior-preserving extraction (Roadmap #19.6B) of code that
 * used to live directly in collect-context.js - see that file's git
 * history for the pre-extraction version. No parsing/matching semantics
 * were changed by the move itself.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeSpecPath } = require("../context-utils");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const REPORTS_DIR = path.join(ROOT, "reports", "cypress");
const SCREENSHOTS_DIR = path.join(ROOT, "cypress", "screenshots");

// Stack traces can run very long (deep call chains, webpack-wrapped
// frames); the error *message* is the critical, never-truncated part -
// only the trailing stack lines are capped.
const MAX_STACK_CHARS = 4000;

// Roadmap #19.5B/#19.6B: this adapter's own stable, canonical,
// machine-readable identity - never inferred, always this constant. The
// generic collector reads this (not a local constant of its own) to set
// context.metadata.framework.
const id = "cypress";

function loadReports(reportsDir = REPORTS_DIR) {
  const warnings = [];

  if (!fs.existsSync(reportsDir)) {
    warnings.push(
      `No report directory found at reports/cypress. Run a test script (e.g. npm run chrome) before ai:collect.`
    );
    return { reports: [], warnings };
  }

  const allJson = fs
    .readdirSync(reportsDir)
    .filter((f) => f.toLowerCase().endsWith(".json"));

  if (allJson.length === 0) {
    warnings.push(`reports/cypress exists but contains no JSON report files.`);
    return { reports: [], warnings };
  }

  // Prefer a merged report (npm run report:merge) if present; otherwise
  // fall back to reading every per-spec mochawesome file.
  const filenames = allJson.includes("report.json") ? ["report.json"] : allJson;

  const reports = [];
  for (const filename of filenames) {
    const fullPath = path.join(reportsDir, filename);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      reports.push(parsed);
    } catch (err) {
      warnings.push(`Could not parse ${path.join("reports", "cypress", filename)}: ${err.message}`);
    }
  }

  return { reports, warnings };
}

// Recursively walks a mochawesome suite tree, yielding every test with its
// resolved ancestor suite titles attached.
function* walkSuite(suite, ancestorTitles) {
  if (!suite) return;

  const titles = suite.title ? [...ancestorTitles, suite.title] : ancestorTitles;

  for (const test of suite.tests || []) {
    yield { test, suiteTitles: titles };
  }
  for (const child of suite.suites || []) {
    yield* walkSuite(child, titles);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveScreenshotPath(specFile, suiteTitles, testTitle, screenshotsDir = SCREENSHOTS_DIR) {
  if (!specFile) return null;
  try {
    const specDir = path.join(screenshotsDir, path.basename(specFile));
    if (!fs.existsSync(specDir)) return null;

    const baseName = [...suiteTitles, testTitle].join(" -- ");
    // Cypress's own on-failure screenshot filename is exactly
    // "<suite -- test> (failed).png", optionally suffixed with an attempt
    // number when retries are enabled (not the case in this repo's config,
    // but handled defensively): "<suite -- test> (failed) (2).png". Only
    // ever return a file we can pin down as *this* failed test's own
    // screenshot - a loose prefix match could otherwise pick up an
    // unrelated screenshot whose title happens to start the same way, or
    // (worse) a screenshot from a test that didn't actually fail.
    const failedPattern = new RegExp(`^${escapeRegExp(baseName)} \\(failed\\)( \\(\\d+\\))?\\.png$`);
    const candidates = fs.readdirSync(specDir).filter((f) => failedPattern.test(f));
    if (candidates.length === 0) return null;

    // With multiple attempts, the highest-numbered one is the most recent.
    candidates.sort();
    const failedShot = candidates[candidates.length - 1];

    return normalizeSpecPath(path.join(specDir, failedShot));
  } catch {
    return null;
  }
}

// Centralized truncation helper (see MAX_STACK_CHARS) - never applied to
// the error message itself, only to fields that can legitimately be huge
// without losing the actually-critical information at the start.
function truncateText(text, maxChars) {
  if (typeof text !== "string") return text;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n/* ...truncated... */` : text;
}

function extractFailedTests(reports, screenshotsDir = SCREENSHOTS_DIR) {
  const failedTests = [];

  for (const report of reports) {
    for (const rootSuite of report.results || []) {
      const specFile = normalizeSpecPath(rootSuite.file || rootSuite.fullFile);

      for (const { test, suiteTitles } of walkSuite(rootSuite, [])) {
        const isFailed = test.state === "failed" || (test.fail === true && test.pending !== true);
        if (!isFailed) continue;

        failedTests.push({
          title: test.title || null,
          fullTitle: test.fullTitle || null,
          suite: suiteTitles.join(" > ") || null,
          specFile,
          status: "failed",
          duration: typeof test.duration === "number" ? test.duration : null,
          error: {
            // Never truncated: the message is the critical part.
            message: (test.err && test.err.message) || null,
            stack: truncateText((test.err && (test.err.estack || test.err.stack)) || null, MAX_STACK_CHARS),
          },
          screenshot: resolveScreenshotPath(specFile, suiteTitles, test.title || "", screenshotsDir),
        });
      }
    }
  }

  return failedTests;
}

function summarizeTestResults(reports) {
  const specs = [];
  const totals = { tests: 0, passed: 0, failed: 0, pending: 0, duration: 0 };

  for (const report of reports) {
    for (const rootSuite of report.results || []) {
      const specFile = normalizeSpecPath(rootSuite.file || rootSuite.fullFile);
      const stats = report.stats || {};

      specs.push({
        specFile,
        tests: stats.tests ?? null,
        passed: stats.passes ?? null,
        failed: stats.failures ?? null,
        pending: stats.pending ?? null,
        duration: stats.duration ?? null,
      });

      totals.tests += stats.tests || 0;
      totals.passed += stats.passes || 0;
      totals.failed += stats.failures || 0;
      totals.pending += stats.pending || 0;
      totals.duration += stats.duration || 0;
    }
  }

  return { found: true, totals, specs };
}

// Roadmap #19.6B: the adapter's own synchronous, thin sequencing
// entrypoint - loads reports, then derives testResults/failedTests from
// them, merging in the discovery warnings. Conceptually mirrors
// collect-context.js's pre-#19.6B main() body, but returns its result
// instead of writing a file or knowing about metadata/ProjectProfile/
// relevantFiles, all of which remain the generic collector's own
// responsibility.
function collect({ reportsDir = REPORTS_DIR, screenshotsDir = SCREENSHOTS_DIR } = {}) {
  const { reports, warnings } = loadReports(reportsDir);

  if (reports.length === 0) {
    return { testResults: { found: false }, failedTests: [], warnings };
  }

  return {
    testResults: summarizeTestResults(reports),
    failedTests: extractFailedTests(reports, screenshotsDir),
    warnings,
  };
}

module.exports = {
  id,
  collect,
  loadReports,
  walkSuite,
  resolveScreenshotPath,
  extractFailedTests,
  summarizeTestResults,
  truncateText,
  REPORTS_DIR,
  SCREENSHOTS_DIR,
};
