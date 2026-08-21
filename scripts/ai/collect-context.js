#!/usr/bin/env node
/**
 * Failure Context Collector
 *
 * Reads the mochawesome JSON report(s) produced by `cypress run` (see
 * reporterOptions in cypress.config.js), extracts failed tests, and writes
 * a single small, LLM-safe JSON file to reports/ai/context.json describing
 * what failed and the minimal source needed to reason about it.
 *
 * No network calls. No AI API calls. No secrets are read.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { TARGOMO_PROJECT_PROFILE } = require("./project-profile");

const ROOT = path.resolve(__dirname, "..", "..");
const REPORTS_DIR = path.join(ROOT, "reports", "cypress");
const OUTPUT_DIR = path.join(ROOT, "reports", "ai");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "context.json");
const SCREENSHOTS_DIR = path.join(ROOT, "cypress", "screenshots");

// Keeps the collected context small and safe to hand to an LLM later.
const MAX_FILE_BYTES = 20 * 1024;
const MAX_TOTAL_RELEVANT_BYTES = 150 * 1024;
// Stack traces can run very long (deep call chains, webpack-wrapped
// frames); the error *message* is the critical, never-truncated part -
// only the trailing stack lines are capped.
const MAX_STACK_CHARS = 4000;

// This repository's single production project (see
// scripts/ai/project-profile.js, Roadmap #19.2). Stable project
// identity and known-constraint text are owned by that module, not here -
// this file only consumes it (project identity/constraints, never a
// classification shortcut - see qa-agent-prompt.js rule 9).
const PROJECT_PROFILE = TARGOMO_PROJECT_PROFILE;

// Roadmap #19.5B: this collector's stable, canonical, machine-readable
// test-framework identity - never inferred from the workflow filename,
// spec file extension, browser, or Mochawesome's own contents, exactly
// the same "stated once, as a constant, not derived" pattern already used
// for PROJECT_PROFILE. This collector is Cypress-specific today (see
// extractFailedTests()'s Mochawesome traversal below), so its own
// identity is exactly and only "cypress" - a future framework's collector
// (Roadmap #19.6+) would state its own constant here, never branch on one.
const FRAMEWORK_ID = "cypress";

// Only files under these repo-relative roots (or exactly matching one of
// the extra allowed paths) are ever read into relevantFiles, even if an
// import resolves elsewhere. This is a defensive boundary, not just a
// convenience filter.
const ALLOWED_DIRS = ["cypress"];
const ALLOWED_FILES = ["cypress.config.js", "package.json"];

// Never read these, even if something inside ALLOWED_DIRS somehow imports
// them (e.g. a future cypress.env.json or a stray .env in cypress/).
const DENYLIST_PATTERN = /(^|[\\/])\.env|secret|credential|\.pem$|\.key$|token/i;

function log(message) {
  process.stdout.write(`[ai:collect] ${message}\n`);
}

function runGit(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function getMetadata() {
  const lifecycleEvent = process.env.npm_lifecycle_event || "";
  const browserFromLifecycle = ["chrome", "firefox", "edge"].includes(lifecycleEvent)
    ? lifecycleEvent
    : null;

  return {
    // Stable, machine-readable project identity (Roadmap #19.2) - always
    // this repository's single production project today; see
    // scripts/ai/project-profile.js for the single source of
    // truth this value is read from.
    projectId: PROJECT_PROFILE.id,
    // Roadmap #19.5B: canonical, unconditional test-framework identity -
    // always this collector's own FRAMEWORK_ID, never derived per-run (see
    // the constant's own comment above).
    framework: FRAMEWORK_ID,
    repository: process.env.GITHUB_REPOSITORY || runGit(["remote", "get-url", "origin"]) || null,
    commit: process.env.GITHUB_SHA || runGit(["rev-parse", "HEAD"]) || null,
    branch:
      process.env.GITHUB_HEAD_REF ||
      process.env.GITHUB_REF_NAME ||
      runGit(["rev-parse", "--abbrev-ref", "HEAD"]) ||
      null,
    runId: process.env.GITHUB_RUN_ID || null,
    event: process.env.GITHUB_EVENT_NAME || null,
    // No GitHub Actions env var carries the Cypress --browser flag, so the
    // workflow sets TEST_BROWSER from matrix.browser explicitly; BROWSER/
    // CYPRESS_BROWSER and the npm script name are best-effort fallbacks
    // for local runs.
    browser:
      process.env.TEST_BROWSER || process.env.BROWSER || process.env.CYPRESS_BROWSER || browserFromLifecycle || null,
    ci: process.env.CI === "true" || process.env.CI === "1",
  };
}

function normalizeSpecPath(rawFile) {
  if (!rawFile) return null;
  let p = rawFile.replace(/\\/g, "/");
  if (p.startsWith(ROOT.replace(/\\/g, "/"))) {
    p = p.slice(ROOT.replace(/\\/g, "/").length);
  }
  p = p.replace(/^\/+/, "");
  return p || null;
}

function loadReports() {
  const warnings = [];

  if (!fs.existsSync(REPORTS_DIR)) {
    warnings.push(
      `No report directory found at reports/cypress. Run a test script (e.g. npm run chrome) before ai:collect.`
    );
    return { reports: [], warnings };
  }

  const allJson = fs
    .readdirSync(REPORTS_DIR)
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
    const fullPath = path.join(REPORTS_DIR, filename);
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

function resolveScreenshotPath(specFile, suiteTitles, testTitle) {
  if (!specFile) return null;
  try {
    const specDir = path.join(SCREENSHOTS_DIR, path.basename(specFile));
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

function extractFailedTests(reports) {
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
          screenshot: resolveScreenshotPath(specFile, suiteTitles, test.title || ""),
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

function isPathAllowed(absPath) {
  const rel = normalizeSpecPath(absPath);
  if (!rel) return false;
  if (DENYLIST_PATTERN.test(rel)) return false;
  if (ALLOWED_FILES.includes(rel)) return true;
  return ALLOWED_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

function readFileSafe(absPath) {
  try {
    if (!isPathAllowed(absPath)) return null;
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;

    const buffer = fs.readFileSync(absPath);
    const truncated = buffer.length > MAX_FILE_BYTES;
    const content = truncated
      ? `${buffer.subarray(0, MAX_FILE_BYTES).toString("utf8")}\n/* ...truncated... */`
      : buffer.toString("utf8");

    return { content, truncated };
  } catch {
    return null;
  }
}

// Best-effort static import resolver for the two module styles used in
// this repo's page objects/specs: ES `import ... from '...'` and CommonJS
// `require('...')`. Only relative imports are followed (bare/package
// imports like "cypress" are irrelevant to failure context).
function resolveLocalImports(sourceCode, fromDir) {
  const importPattern = /(?:from\s+|require\()\s*['"](\.[^'"]+)['"]/g;
  const resolved = new Set();
  let match;

  while ((match = importPattern.exec(sourceCode)) !== null) {
    const specifier = match[1];
    const base = path.resolve(fromDir, specifier);
    const candidates = [base, `${base}.js`, path.join(base, "index.js")];

    const found = candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });

    if (found) resolved.add(found);
  }

  return [...resolved];
}

function buildRelevantFiles(failedTests, warnings) {
  const files = {};
  let totalBytes = 0;

  const addFile = (absPath) => {
    const rel = normalizeSpecPath(absPath);
    if (!rel || files[rel]) return;

    if (totalBytes >= MAX_TOTAL_RELEVANT_BYTES) {
      warnings.push(`relevantFiles size cap reached; skipped ${rel}.`);
      return;
    }

    const result = readFileSafe(absPath);
    if (!result) return;

    files[rel] = result;
    totalBytes += result.content.length;
  };

  // Test runner config and package.json give the AI step baseline project
  // context (browser/base URL config, available scripts/deps).
  addFile(path.join(ROOT, "cypress.config.js"));
  addFile(path.join(ROOT, "package.json"));

  const specPaths = new Set(failedTests.map((t) => t.specFile).filter(Boolean));

  for (const specRelPath of specPaths) {
    const specAbsPath = path.join(ROOT, specRelPath);
    const specResult = readFileSafe(specAbsPath);
    if (!specResult) {
      warnings.push(`Failed spec source not found on disk: ${specRelPath}`);
      continue;
    }
    addFile(specAbsPath);

    const imports = resolveLocalImports(specResult.content, path.dirname(specAbsPath));
    for (const importedAbsPath of imports) {
      addFile(importedAbsPath);
    }
  }

  return files;
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const metadata = getMetadata();
  const { reports, warnings } = loadReports();

  let testResults = { found: false };
  let failedTests = [];
  let relevantFiles = {};
  let knownProjectConstraints = [];

  if (reports.length > 0) {
    testResults = summarizeTestResults(reports);
    failedTests = extractFailedTests(reports);
    if (failedTests.length > 0) {
      relevantFiles = buildRelevantFiles(failedTests, warnings);
      knownProjectConstraints = PROJECT_PROFILE.knownProjectConstraints;
    }
  }

  const context = {
    generatedAt: new Date().toISOString(),
    metadata,
    testResults,
    failedTests,
    relevantFiles,
    knownProjectConstraints,
    warnings,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(context, null, 2));

  log(
    `wrote ${path.relative(ROOT, OUTPUT_FILE)} ` +
      `(${failedTests.length} failed test(s), ${Object.keys(relevantFiles).length} relevant file(s))`
  );
  for (const warning of warnings) {
    log(`warning: ${warning}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeSpecPath,
  loadReports,
  walkSuite,
  resolveScreenshotPath,
  extractFailedTests,
  summarizeTestResults,
  isPathAllowed,
  readFileSafe,
  resolveLocalImports,
  buildRelevantFiles,
  getMetadata,
  truncateText,
  main,
};
