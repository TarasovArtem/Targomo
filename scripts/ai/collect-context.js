#!/usr/bin/env node
/**
 * Failure Context Collector
 *
 * Reads the mochawesome JSON report(s) produced by `cypress run` (via the
 * Cypress adapter, see scripts/ai/adapters/cypress-adapter.js), extracts
 * failed tests, and writes a single small, LLM-safe JSON file to
 * reports/ai/context.json describing what failed and the minimal source
 * needed to reason about it.
 *
 * No network calls. No AI API calls. No secrets are read.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { TARGOMO_PROJECT_PROFILE } = require("./project-profile");
const { normalizeSpecPath } = require("./context-utils");
const cypressAdapter = require("./adapters/cypress-adapter");

const ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT_DIR = path.join(ROOT, "reports", "ai");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "context.json");

// Keeps the collected context small and safe to hand to an LLM later.
const MAX_FILE_BYTES = 20 * 1024;
const MAX_TOTAL_RELEVANT_BYTES = 150 * 1024;

// This repository's single production project (see
// scripts/ai/project-profile.js, Roadmap #19.2). Stable project
// identity and known-constraint text are owned by that module, not here -
// this file only consumes it (project identity/constraints, never a
// classification shortcut - see qa-agent-prompt.js rule 9).
const PROJECT_PROFILE = TARGOMO_PROJECT_PROFILE;

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
    // Roadmap #19.5B/#19.6B: canonical, unconditional test-framework
    // identity - read from the current adapter's own stable identity
    // (scripts/ai/adapters/cypress-adapter.js), never derived per-run and
    // never a second, separately-hardcoded constant here.
    framework: cypressAdapter.id,
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
  const adapterResult = cypressAdapter.collect();
  const { testResults, failedTests } = adapterResult;
  // Copied, not mutated in place - Roadmap #19.6B: the adapter's returned
  // result is treated as an immutable contract, even though the resulting
  // warnings *values*/order below are identical to the pre-#19.6B
  // behavior of pushing directly onto loadReports()'s own array.
  const warnings = [...adapterResult.warnings];

  let relevantFiles = {};
  let knownProjectConstraints = [];

  if (failedTests.length > 0) {
    relevantFiles = buildRelevantFiles(failedTests, warnings);
    knownProjectConstraints = PROJECT_PROFILE.knownProjectConstraints;
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
  isPathAllowed,
  readFileSafe,
  resolveLocalImports,
  buildRelevantFiles,
  getMetadata,
  main,
};
