#!/usr/bin/env node
/**
 * Flaky-test history collector.
 *
 * Queries the GitHub Actions REST API for the last N completed runs of
 * this workflow on a reference branch (default: main), and aggregates how
 * often THIS matrix leg's job (browser) passed/failed - a cheap,
 * GitHub-native signal: no external database, no artifact downloads/unzip,
 * no new npm dependency (uses Node's built-in fetch).
 *
 * Job-level (i.e. per-browser), not per-individual-test: this repo's
 * structured test reports are only uploaded on failure (see
 * cypress-report-<browser> in the workflow), so there is nothing to parse
 * for *passing* historical runs - job conclusion is the cheapest signal
 * that is actually available for every run, pass or fail.
 *
 * Reference branch is always `main`, not the current branch: for a
 * pull_request run this deliberately looks at trunk's recent trend for
 * this browser (a stable signal), not the PR's own short-lived branch
 * (which usually has no history at all on its first run).
 *
 * Entirely optional and best-effort: no token, an API error, this being
 * the first-ever run, or anything else going wrong writes an
 * { available: false } marker and exits 0 - analyze-failure.js treats
 * history as optional input and keeps working without it.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { TARGOMO_PROJECT_PROFILE } = require("./project-profile");

const ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT_FILE = path.join(ROOT, "reports", "ai", "history.json");

// This repository's single production project (see
// scripts/ai/project-profile.js, Roadmap #19.2/#19.3C). Stable project
// identity is owned by that module, not here - this file only consumes
// it, so the aggregate can be scoped to the project it was actually
// collected for without ever hardcoding that project's id here.
const PROJECT_PROFILE = TARGOMO_PROJECT_PROFILE;

// This script is specific to this repo's single workflow file, matching
// how other scripts/ai/*.js already hardcode repo-specific details (spec
// paths, page object locations) rather than generalizing prematurely.
const WORKFLOW_FILE = "cypress.yml";
const DEFAULT_RUNS = 10;
const DEFAULT_BRANCH = "main";
// Hard ceiling on HISTORY_RUNS regardless of what the env var requests -
// each run considered costs one extra API call (see aggregateHistory), so
// an accidental misconfiguration (e.g. HISTORY_RUNS=500) shouldn't be able
// to turn one CI step into hundreds of requests.
const MAX_RUNS = 30;

// Same retry policy as analyze-failure.js's AI provider call, for the same
// reason: rate limiting and gateway/server errors are worth one or two
// quick retries, but a 401/403/404 will just fail identically again.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status);
}

function clampRunsWanted(rawValue) {
  return Math.min(Math.max(Number(rawValue) || DEFAULT_RUNS, 1), MAX_RUNS);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  process.stdout.write(`[ai:history] ${message}\n`);
}

function writeUnavailable(reason) {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ available: false, reason }, null, 2));
  log(`history unavailable: ${reason}`);
}

async function fetchJson(apiBase, token, urlPath, { maxAttempts = 3, retryDelaysMs = [500, 1500], sleep = defaultSleep } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetch(`${apiBase}${urlPath}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (err) {
      // Never got a response at all (network blip, timeout) - worth retrying.
      lastErr = err;
      if (attempt === maxAttempts) break;
      await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1]);
      continue;
    }

    if (res.ok) return res.json();

    lastErr = new Error(`GitHub API ${res.status} ${res.statusText} for ${urlPath}`);
    if (attempt === maxAttempts || !isRetryableStatus(res.status)) break;
    await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1]);
  }

  throw lastErr;
}

// Pure aggregation step, separated from the HTTP calls so it can be unit
// tested with fake run/job data and no network access. `getJobsForRun` is
// `async (run) => [{ name, conclusion }, ...]`. Job lookups run
// concurrently (Promise.all) - same number of API calls as before, just
// not paid for serially one run at a time.
async function aggregateHistory({ runs, browser, getJobsForRun }) {
  const lookups = await Promise.all(
    runs.map(async (run) => {
      try {
        return { run, jobs: await getJobsForRun(run) };
      } catch {
        return null; // best-effort: skip a run we couldn't inspect, don't fail the whole thing
      }
    })
  );

  let passes = 0;
  let failures = 0;
  let retryPasses = 0;
  let inspected = 0;

  for (const lookup of lookups) {
    if (!lookup) continue;
    const { run, jobs } = lookup;
    const job = (jobs || []).find((j) => j.name === `Cypress - ${browser}`);
    if (!job) continue;

    // Only success/failure are meaningful pass/fail data points - a
    // cancelled or skipped job conclusion isn't a "this browser passed or
    // failed" result and must not be counted, or passes+failures would no
    // longer add up to runsConsidered (the schema promises they do, e.g.
    // the task's own 7 passes + 3 failures = 10 runsConsidered example).
    if (job.conclusion === "success") {
      inspected += 1;
      passes += 1;
      // A run that failed on an earlier attempt and then passed after a
      // GitHub Actions job re-run. This is NOT a Cypress-level test retry
      // (this repo doesn't configure Cypress `retries`) - it's the
      // coarser "someone/something re-ran the failed job and it passed"
      // signal, which is what run_attempt actually tracks.
      if (run.run_attempt > 1) retryPasses += 1;
    } else if (job.conclusion === "failure") {
      inspected += 1;
      failures += 1;
    }
  }

  return { passes, failures, retryPasses, inspected };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const browser = process.env.TEST_BROWSER;
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const branch = process.env.HISTORY_BRANCH || DEFAULT_BRANCH;
  const runsWanted = clampRunsWanted(process.env.HISTORY_RUNS);
  const currentRunId = process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null;

  if (!token) return writeUnavailable("GITHUB_TOKEN not set");
  if (!repo) return writeUnavailable("GITHUB_REPOSITORY not set");
  if (!browser) return writeUnavailable("TEST_BROWSER not set");

  let runsResponse;
  try {
    runsResponse = await fetchJson(
      apiBase,
      token,
      `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${
        runsWanted + 1
      }`
    );
  } catch (err) {
    return writeUnavailable(`could not list workflow runs: ${err.message}`);
  }

  const runs = (runsResponse.workflow_runs || []).filter((r) => r.id !== currentRunId).slice(0, runsWanted);

  if (runs.length === 0) {
    return writeUnavailable(`no prior completed runs found on branch '${branch}' yet`);
  }

  const { passes, failures, retryPasses, inspected } = await aggregateHistory({
    runs,
    browser,
    getJobsForRun: async (run) => {
      const jobsResponse = await fetchJson(apiBase, token, `/repos/${repo}/actions/runs/${run.id}/jobs`);
      return jobsResponse.jobs || [];
    },
  });

  if (inspected === 0) {
    return writeUnavailable(`no prior '${browser}' job history found in the last ${runs.length} run(s) on '${branch}'`);
  }

  const history = {
    available: true,
    // Stable project identity (Roadmap #19.3C) - the project this
    // aggregate was actually collected for, so a consumer analyzing a
    // different (or unknown) current project can refuse to trust it
    // rather than silently treating it as universally applicable. See
    // scripts/ai/project-profile.js for the single source of truth this
    // value is read from.
    projectId: PROJECT_PROFILE.id,
    browser,
    branch,
    runsConsidered: inspected,
    passes,
    failures,
    retryPasses,
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(history, null, 2));
  log(
    `wrote ${path.relative(ROOT, OUTPUT_FILE)} (${passes} pass, ${failures} fail, ${retryPasses} retry-pass of ${inspected} run(s) considered)`
  );
}

if (require.main === module) {
  main().catch((err) => writeUnavailable(`unexpected error: ${err.message}`));
}

module.exports = {
  main,
  aggregateHistory,
  fetchJson,
  isRetryableStatus,
  clampRunsWanted,
  WORKFLOW_FILE,
  DEFAULT_RUNS,
  DEFAULT_BRANCH,
  MAX_RUNS,
  PROJECT_PROFILE,
};
