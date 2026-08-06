"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { aggregateHistory, fetchJson, isRetryableStatus, clampRunsWanted, DEFAULT_RUNS, MAX_RUNS } = require("./collect-history");

function run({ id, run_attempt = 1 }) {
  return { id, run_attempt };
}

test("aggregateHistory: counts passes and failures per browser from job conclusions", async () => {
  const runs = [run({ id: 1 }), run({ id: 2 }), run({ id: 3 }), run({ id: 4 }), run({ id: 5 })];
  const jobsByRun = {
    1: [{ name: "Cypress - chrome", conclusion: "success" }],
    2: [{ name: "Cypress - chrome", conclusion: "success" }],
    3: [{ name: "Cypress - chrome", conclusion: "success" }],
    4: [{ name: "Cypress - chrome", conclusion: "failure" }],
    5: [{ name: "Cypress - chrome", conclusion: "success" }],
  };

  const result = await aggregateHistory({
    runs,
    browser: "chrome",
    getJobsForRun: async (r) => jobsByRun[r.id],
  });

  assert.deepEqual(result, { passes: 4, failures: 1, retryPasses: 0, inspected: 5 });
});

test("aggregateHistory: is browser-specific - only matches this browser's job name", async () => {
  const runs = [run({ id: 1 })];
  const jobsByRun = {
    1: [
      { name: "Cypress - chrome", conclusion: "success" },
      { name: "Cypress - edge", conclusion: "failure" },
    ],
  };

  const chromeResult = await aggregateHistory({ runs, browser: "chrome", getJobsForRun: async (r) => jobsByRun[r.id] });
  const edgeResult = await aggregateHistory({ runs, browser: "edge", getJobsForRun: async (r) => jobsByRun[r.id] });

  assert.equal(chromeResult.passes, 1);
  assert.equal(chromeResult.failures, 0);
  assert.equal(edgeResult.passes, 0);
  assert.equal(edgeResult.failures, 1);
});

test("aggregateHistory: counts retryPasses only when the job succeeded on a re-run (run_attempt > 1)", async () => {
  const runs = [run({ id: 1, run_attempt: 1 }), run({ id: 2, run_attempt: 2 }), run({ id: 3, run_attempt: 3 })];
  const jobsByRun = {
    1: [{ name: "Cypress - chrome", conclusion: "success" }], // first-attempt pass, not a retry
    2: [{ name: "Cypress - chrome", conclusion: "success" }], // passed after a re-run
    3: [{ name: "Cypress - chrome", conclusion: "failure" }], // failed even after a re-run
  };

  const result = await aggregateHistory({ runs, browser: "chrome", getJobsForRun: async (r) => jobsByRun[r.id] });
  assert.equal(result.retryPasses, 1);
  assert.equal(result.passes, 2);
  assert.equal(result.failures, 1);
});

test("aggregateHistory: ignores conclusions other than success/failure (e.g. cancelled) without crashing", async () => {
  const runs = [run({ id: 1 }), run({ id: 2 })];
  const jobsByRun = {
    1: [{ name: "Cypress - chrome", conclusion: "cancelled" }],
    2: [{ name: "Cypress - chrome", conclusion: "success" }],
  };

  const result = await aggregateHistory({ runs, browser: "chrome", getJobsForRun: async (r) => jobsByRun[r.id] });
  assert.equal(result.passes, 1);
  assert.equal(result.failures, 0);
  assert.equal(result.inspected, 1, "the cancelled run should not count toward runsConsidered");
});

test("aggregateHistory: skips a run whose job lookup fails, without throwing", async () => {
  const runs = [run({ id: 1 }), run({ id: 2 })];

  const result = await aggregateHistory({
    runs,
    browser: "chrome",
    getJobsForRun: async (r) => {
      if (r.id === 1) throw new Error("network error");
      return [{ name: "Cypress - chrome", conclusion: "success" }];
    },
  });

  assert.equal(result.inspected, 1);
  assert.equal(result.passes, 1);
});

test("aggregateHistory: a job matching a different browser name is not counted at all", async () => {
  const runs = [run({ id: 1 })];
  const jobsByRun = { 1: [{ name: "Some other job", conclusion: "success" }] };

  const result = await aggregateHistory({ runs, browser: "chrome", getJobsForRun: async (r) => jobsByRun[r.id] });
  assert.equal(result.inspected, 0);
});

test("aggregateHistory: no runs at all -> zeroed-out result, no crash", async () => {
  const result = await aggregateHistory({ runs: [], browser: "chrome", getJobsForRun: async () => [] });
  assert.deepEqual(result, { passes: 0, failures: 0, retryPasses: 0, inspected: 0 });
});

test("clampRunsWanted: falls back to the default when unset, non-numeric, or zero", () => {
  assert.equal(clampRunsWanted(undefined), DEFAULT_RUNS);
  assert.equal(clampRunsWanted("not-a-number"), DEFAULT_RUNS);
  assert.equal(clampRunsWanted("0"), DEFAULT_RUNS, "0 is falsy, so it's treated the same as unset");
});

test("clampRunsWanted: a negative value clamps up to the minimum of 1", () => {
  assert.equal(clampRunsWanted("-5"), 1);
});

test("clampRunsWanted: honors a reasonable explicit value", () => {
  assert.equal(clampRunsWanted("5"), 5);
});

test("clampRunsWanted: never exceeds MAX_RUNS regardless of what's requested", () => {
  assert.equal(clampRunsWanted("500"), MAX_RUNS);
  assert.ok(MAX_RUNS < 500, "sanity check that the test is actually exercising the clamp");
});

test("isRetryableStatus: 429 and 5xx are retryable, 4xx auth/lookup errors are not", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(404), false);
});

test("fetchJson: retries a transient 503 and succeeds on a later attempt", async (t) => {
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 503, statusText: "Service Unavailable" };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await fetchJson("https://api.github.com", "tok", "/repos/o/r/actions/runs/1/jobs", {
    sleep: async () => {},
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, { ok: true });
});

test("fetchJson: never retries a 404 - fails on the first attempt", async (t) => {
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 404, statusText: "Not Found" };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(() =>
    fetchJson("https://api.github.com", "tok", "/repos/o/r/actions/runs/1/jobs", { sleep: async () => {} })
  );
  assert.equal(calls, 1);
});

test("fetchJson: gives up after maxAttempts on a persistent transient error", async (t) => {
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 500, statusText: "Internal Server Error" };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(() =>
    fetchJson("https://api.github.com", "tok", "/x", { maxAttempts: 3, sleep: async () => {} })
  );
  assert.equal(calls, 3);
});
