"use strict";

/**
 * Roadmap #19.4 - Synthetic Second-Project Portability Proof.
 *
 * A fully offline Level-3 integration proof that the existing generic QA
 * Agent core (ProjectProfile -> project-specific context -> Knowledge gate
 * -> History gate -> buildFailureReport() -> systemPrompt/userPrompt ->
 * provider -> policy -> report) can process TWO distinct logical project
 * identities without cross-project leakage, and without adding a second
 * production ProjectProfile, a second production SUT, or any production
 * code change (see scripts/ai/project-profile.js, scripts/ai/analyze-failure.js,
 * scripts/ai/qa-agent-prompt.js, scripts/ai/knowledge/** - all untouched
 * by this file).
 *
 * Project A is the real, current production ProjectProfile
 * (TARGOMO_PROJECT_PROFILE) - the control. Project B is a test-only
 * synthetic ProjectProfile, never exported from production, never
 * registered anywhere - it exists purely as data supplied to the same
 * generic functions Project A already uses (see project-profile.js's own
 * doc comment, which anticipates exactly this).
 *
 * Framework (cypress), browser (firefox), provider behavior, and failure
 * semantics (title/error/spec) are held constant between A and B - only
 * genuinely project-specific inputs differ: ProjectProfile identity,
 * knownProjectConstraints, project-scoped Knowledge, and
 * project-namespaced History.
 *
 * History note (see the #19.4 mission's explicit instruction): this file
 * never writes to the shared reports/ai/history.json path used elsewhere
 * in the test suite (see analyze-failure.test.js's own writeHistoryFixture
 * tests) - that would add another concurrent writer to a resource with an
 * already-identified pre-existing filesystem race. Roadmap #19.3C already
 * separately covers file parsing/legacy behavior end to end. Instead, this
 * file constructs valid in-memory History aggregates and calls the real,
 * exported, pure eligibility gate (classifyProjectId +
 * isHistoryProjectEligible) directly - proving actual gate behavior
 * without reimplementing it and without touching the filesystem.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFailureReport,
  classifyProjectId,
  isHistoryProjectEligible,
} = require("./analyze-failure");
const { TARGOMO_PROJECT_PROFILE, validateProjectProfile } = require("./project-profile");
const { loadKnowledgeUnits } = require("./knowledge/loader");
const { selectKnowledge } = require("./knowledge/selector");
const { validateKnowledgeUnit } = require("./knowledge/schema");

// --- Project A (control) ---------------------------------------------------
// The real, current production profile - never duplicated manually.
const PROFILE_A = TARGOMO_PROJECT_PROFILE;

// --- Project B (test-only synthetic) ---------------------------------------
// Never exported from production, never registered anywhere - exists only
// in this test file's memory.
const PROFILE_B = {
  id: "synthetic-project",
  displayName: "PROJECT_B_DISPLAY_NAME_SENTINEL",
  knownProjectConstraints: ["PROJECT_B_CONSTRAINT_SENTINEL"],
};

// --- Project B's synthetic, test-local Knowledge unit -----------------------
// Follows the exact real schema (see knowledge/schema.js), validated below
// through the real validateKnowledgeUnit() - never written into
// scripts/ai/knowledge/units/. Its tag is a sentinel unlikely to collide
// with any production unit's tags (confirmed by inspection of the real
// corpus: no existing unit's tags contain this literal).
const SYNTHETIC_B_KNOWLEDGE_UNIT = {
  id: "test-only-project-b-scoped-knowledge",
  category: "PROJECT",
  sourceType: "PROJECT_VERIFIED",
  source: null,
  verifiedAt: "2026-08-20",
  tags: ["PROJECT_B_KNOWLEDGE_TAG_SENTINEL"],
  appliesTo: { browsers: null, frameworks: null, projects: ["synthetic-project"] },
  statement: "PROJECT_B_KNOWLEDGE_SENTINEL",
  priority: 5,
};

// --- Controlled dimensions: identical for A and B --------------------------
// The error message deliberately contains three, and only three, distinct
// keyword signals: "job isolation"/"fresh runner" (the real global
// ci-job-isolation-runner-state unit's tags) and the synthetic B unit's own
// tag. It intentionally avoids any substring ("timed out retrying",
// "retry", "cy.get", "cannot be interacted with") that would additionally
// match the other three real, project-independent Knowledge units - this
// keeps the selection matrix in Phase 12 exactly the three units under
// test, not an uncontrolled larger set.
const SHARED_FAILED_TEST = {
  title: "should load POI tiles",
  specFile: "cypress/e2e/tests/shared_spec.cy.js",
  error: { message: "job isolation fresh runner PROJECT_B_KNOWLEDGE_TAG_SENTINEL failure" },
};

function buildContext(profile) {
  return {
    metadata: {
      projectId: profile.id,
      browser: "firefox",
      commit: "c1",
      branch: "main",
      event: "push",
      ci: true,
    },
    testResults: { found: true, totals: { tests: 1, passed: 0, failed: 1, pending: 0, duration: 100 }, specs: [] },
    failedTests: [SHARED_FAILED_TEST],
    relevantFiles: {},
    warnings: [],
    knownProjectConstraints: profile.knownProjectConstraints,
    browserCorrelation: null,
  };
}

function capturingProvider(resultOverrides = {}) {
  const captured = [];
  const provider = {
    name: "capturing-test-provider",
    async analyze(request) {
      captured.push(request);
      return JSON.stringify({
        results: [
          {
            test: { title: SHARED_FAILED_TEST.title, specFile: SHARED_FAILED_TEST.specFile },
            classification: "UNKNOWN",
            confidence: 0.5,
            summary: "Summary.",
            rootCause: "Root cause.",
            evidence: ["err.message: " + SHARED_FAILED_TEST.error.message],
            recommendedFix: null,
            shouldCreateBug: false,
            shouldRetry: false,
            ...resultOverrides,
          },
        ],
      });
    },
  };
  return { provider, captured };
}

function parsePromptPayload(userPrompt) {
  return JSON.parse(userPrompt.slice(userPrompt.indexOf("{"), userPrompt.lastIndexOf("}") + 1));
}

// Real production Knowledge corpus, extended only in memory - never
// written to scripts/ai/knowledge/units/.
const combinedUnits = [...loadKnowledgeUnits(), SYNTHETIC_B_KNOWLEDGE_UNIT];

// --- 1. Synthetic Project B is a valid ProjectProfile / Knowledge unit -----

test("Roadmap #19.4: synthetic Project B validates as a real ProjectProfile under the actual contract", () => {
  assert.equal(validateProjectProfile(PROFILE_B).valid, true);
});

test("Roadmap #19.4: Project B's synthetic Knowledge unit validates under the real Knowledge schema", () => {
  assert.equal(validateKnowledgeUnit(SYNTHETIC_B_KNOWLEDGE_UNIT).valid, true);
});

// --- 2. Symmetric Knowledge isolation, using the real selector -------------

test("Roadmap #19.4: symmetric Knowledge isolation - A-specific and B-specific units are each allowed for their own project and skipped for the other, global Knowledge reaches both", () => {
  const contextA = buildContext(PROFILE_A);
  const contextB = buildContext(PROFILE_B);

  const selectedA = selectKnowledge(contextA, combinedUnits);
  const selectedB = selectKnowledge(contextB, combinedUnits);

  const idsA = selectedA.map((u) => u.id);
  const idsB = selectedB.map((u) => u.id);

  // A-scoped production unit: ALLOW for A, SKIP for B.
  assert.ok(idsA.includes("project-firefox-execution-environment-split"));
  assert.equal(idsB.includes("project-firefox-execution-environment-split"), false);

  // B-scoped synthetic unit: ALLOW for B, SKIP for A.
  assert.ok(idsB.includes(SYNTHETIC_B_KNOWLEDGE_UNIT.id));
  assert.equal(idsA.includes(SYNTHETIC_B_KNOWLEDGE_UNIT.id), false);
  assert.ok(selectedB.some((u) => u.statement === "PROJECT_B_KNOWLEDGE_SENTINEL"));
  assert.equal(selectedA.some((u) => u.statement === "PROJECT_B_KNOWLEDGE_SENTINEL"), false);

  // Global (projects: null) unit: ALLOW for both.
  assert.ok(idsA.includes("ci-job-isolation-runner-state"));
  assert.ok(idsB.includes("ci-job-isolation-runner-state"));
});

// --- 3. Symmetric History isolation, using the real pure eligibility gate --

// In-memory only - never written to reports/ai/history.json. Module-scoped
// (not test-local) so the Level-3 downstream projection below can be
// derived from these same objects through the real gate's own return
// value, rather than a second, separately hand-typed literal that would
// only coincidentally match - see the derivation immediately after the
// isolation test for why this matters.
const historyAggregateA = { available: true, projectId: PROFILE_A.id, runsConsidered: 10, passes: 7, failures: 3, retryPasses: 1 };
const historyAggregateB = { available: true, projectId: PROFILE_B.id, runsConsidered: 8, passes: 5, failures: 3, retryPasses: 0 };

test("Roadmap #19.4: symmetric History isolation via the real pure project-eligibility gate (classifyProjectId + isHistoryProjectEligible), no filesystem writer added", () => {
  const currentA = classifyProjectId({ projectId: PROFILE_A.id }, "projectId");
  const currentB = classifyProjectId({ projectId: PROFILE_B.id }, "projectId");
  const historyAIdentity = classifyProjectId(historyAggregateA, "projectId");
  const historyBIdentity = classifyProjectId(historyAggregateB, "projectId");

  assert.equal(isHistoryProjectEligible(currentA, historyAIdentity), true, "A current + A history -> ALLOW");
  assert.equal(isHistoryProjectEligible(currentA, historyBIdentity), false, "A current + B history -> SKIP");
  assert.equal(isHistoryProjectEligible(currentB, historyBIdentity), true, "B current + B history -> ALLOW");
  assert.equal(isHistoryProjectEligible(currentB, historyAIdentity), false, "B current + A history -> SKIP");
});

// Downstream, gate-approved History objects for the Level-3 calls below -
// genuinely derived from the real gate's own boolean return value, not a
// second, independently hand-typed literal that would only coincidentally
// match test 3's fixtures. If isHistoryProjectEligible() were ever wrong
// (e.g. regressed to always return false), this would become null and the
// Level-3 tests below would fail on their own assertions, rather than
// silently continuing to pass against a stale, disconnected constant. This
// only reproduces the already-established #19.3C stripped downstream shape
// ({runsConsidered, passes, failures, retryPasses}, no projectId/available)
// - it does NOT re-test file parsing or legacy behavior, which #19.3C's own
// suite already covers.
function projectDownstreamHistory(aggregate) {
  const { available, projectId, ...rest } = aggregate;
  return rest;
}

const approvedHistoryA = isHistoryProjectEligible(
  classifyProjectId({ projectId: PROFILE_A.id }, "projectId"),
  classifyProjectId(historyAggregateA, "projectId")
)
  ? projectDownstreamHistory(historyAggregateA)
  : null;

const approvedHistoryB = isHistoryProjectEligible(
  classifyProjectId({ projectId: PROFILE_B.id }, "projectId"),
  classifyProjectId(historyAggregateB, "projectId")
)
  ? projectDownstreamHistory(historyAggregateB)
  : null;

// --- 4. Project A Level-3 control path --------------------------------------

test("Roadmap #19.4: Project A Level-3 offline path - real systemPrompt/userPrompt/report, A semantics present, B sentinels absent", async () => {
  const contextA = buildContext(PROFILE_A);
  const selectedA = selectKnowledge(contextA, combinedUnits);
  const { provider, captured } = capturingProvider();

  const report = await buildFailureReport(contextA, {
    provider,
    projectProfile: PROFILE_A,
    history: approvedHistoryA,
    relevantKnowledge: selectedA,
  });

  assert.equal(captured.length, 1);
  assert.deepEqual(Object.keys(captured[0]).sort(), ["systemPrompt", "userPrompt"]);

  assert.match(captured[0].systemPrompt, new RegExp(PROFILE_A.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(captured[0].systemPrompt.includes("PROJECT_B_DISPLAY_NAME_SENTINEL"), false);

  const payload = parsePromptPayload(captured[0].userPrompt);
  assert.deepEqual(payload.knownProjectConstraints, PROFILE_A.knownProjectConstraints);
  assert.equal(captured[0].userPrompt.includes("PROJECT_B_CONSTRAINT_SENTINEL"), false);

  const promptedIds = payload.relevantKnowledge.map((k) => k.id);
  assert.ok(promptedIds.includes("project-firefox-execution-environment-split"));
  assert.ok(promptedIds.includes("ci-job-isolation-runner-state"));
  assert.equal(promptedIds.includes(SYNTHETIC_B_KNOWLEDGE_UNIT.id), false);
  assert.equal(captured[0].userPrompt.includes("PROJECT_B_KNOWLEDGE_SENTINEL"), false);

  assert.deepEqual(payload.history, approvedHistoryA);

  assert.equal(report.sourceContext.projectId, PROFILE_A.id);
});

// --- 5. Project B Level-3 path - the SAME generic function ------------------

test("Roadmap #19.4: Project B Level-3 offline path via the SAME generic buildFailureReport() - B semantics present, A semantics absent", async () => {
  const contextB = buildContext(PROFILE_B);
  const selectedB = selectKnowledge(contextB, combinedUnits);
  const { provider, captured } = capturingProvider();

  const report = await buildFailureReport(contextB, {
    provider,
    projectProfile: PROFILE_B,
    history: approvedHistoryB,
    relevantKnowledge: selectedB,
  });

  assert.equal(captured.length, 1);
  assert.deepEqual(Object.keys(captured[0]).sort(), ["systemPrompt", "userPrompt"]);

  assert.match(captured[0].systemPrompt, /PROJECT_B_DISPLAY_NAME_SENTINEL/);
  assert.equal(captured[0].systemPrompt.includes(PROFILE_A.displayName), false);

  const payload = parsePromptPayload(captured[0].userPrompt);
  assert.deepEqual(payload.knownProjectConstraints, PROFILE_B.knownProjectConstraints);
  for (const aConstraint of PROFILE_A.knownProjectConstraints) {
    assert.equal(captured[0].userPrompt.includes(aConstraint), false);
  }

  const promptedIds = payload.relevantKnowledge.map((k) => k.id);
  assert.ok(promptedIds.includes(SYNTHETIC_B_KNOWLEDGE_UNIT.id));
  assert.ok(promptedIds.includes("ci-job-isolation-runner-state"));
  assert.equal(promptedIds.includes("project-firefox-execution-environment-split"), false);

  assert.deepEqual(payload.history, approvedHistoryB);

  assert.equal(report.sourceContext.projectId, PROFILE_B.id);
  assert.notEqual(report.sourceContext.projectId, PROFILE_A.id);
});

// --- 6. Namespace/scope metadata invisibility (structural, not substring) --

test("Roadmap #19.4: internal namespace ids and Knowledge/History project-scope metadata remain structurally absent from provider-visible input for both projects", async () => {
  const contextA = buildContext(PROFILE_A);
  const contextB = buildContext(PROFILE_B);
  const selectedA = selectKnowledge(contextA, combinedUnits);
  const selectedB = selectKnowledge(contextB, combinedUnits);

  const runA = capturingProvider();
  const runB = capturingProvider();

  await buildFailureReport(contextA, { provider: runA.provider, projectProfile: PROFILE_A, history: approvedHistoryA, relevantKnowledge: selectedA });
  await buildFailureReport(contextB, { provider: runB.provider, projectProfile: PROFILE_B, history: approvedHistoryB, relevantKnowledge: selectedB });

  for (const { captured, profile } of [
    { captured: runA.captured[0], profile: PROFILE_A },
    { captured: runB.captured[0], profile: PROFILE_B },
  ]) {
    assert.equal(captured.userPrompt.includes('"projectId"'), false, `${profile.id}: literal "projectId" key must not appear`);
    assert.equal(captured.userPrompt.includes(PROFILE_A.id), false, `${profile.id}: Project A internal id absent`);
    assert.equal(captured.userPrompt.includes(PROFILE_B.id), false, `${profile.id}: Project B internal id absent`);

    const payload = parsePromptPayload(captured.userPrompt);

    // History exposes only the stripped downstream shape.
    assert.deepEqual(Object.keys(payload.history).sort(), ["failures", "passes", "retryPasses", "runsConsidered"]);

    // Selected Knowledge exposes only {id, statement}.
    for (const unit of payload.relevantKnowledge) {
      assert.deepEqual(Object.keys(unit).sort(), ["id", "statement"]);
    }
    assert.equal(captured.userPrompt.includes("appliesTo"), false);
    assert.equal(JSON.stringify(payload).includes('"projects"'), false);
  }
});

// --- 7. Policy invariance across identical fixed provider response ---------

test("Roadmap #19.4: the same fixed provider response yields identical deterministic policy behavior for A and B - project identity never reaches applyAgentPolicy()", async () => {
  const contextA = buildContext(PROFILE_A);
  const contextB = buildContext(PROFILE_B);
  const selectedA = selectKnowledge(contextA, combinedUnits);
  const selectedB = selectKnowledge(contextB, combinedUnits);

  const fixedOverrides = { classification: "UNKNOWN", confidence: 0.42, shouldCreateBug: false };

  const reportA = await buildFailureReport(contextA, {
    provider: capturingProvider(fixedOverrides).provider,
    projectProfile: PROFILE_A,
    history: approvedHistoryA,
    relevantKnowledge: selectedA,
  });
  const reportB = await buildFailureReport(contextB, {
    provider: capturingProvider(fixedOverrides).provider,
    projectProfile: PROFILE_B,
    history: approvedHistoryB,
    relevantKnowledge: selectedB,
  });

  assert.equal(reportA.results[0].classification, reportB.results[0].classification);
  assert.equal(reportA.results[0].confidence, reportB.results[0].confidence);
  assert.equal(reportA.results[0].shouldCreateBug, reportB.results[0].shouldCreateBug);
  assert.equal(reportA.results[0].shouldCreateBug, false);
});

// --- 8. Project B bug-creation safeguard, through the full Level-3 path ----

test("Roadmap #19.4: Project B cannot retain shouldCreateBug=true for TEST_BUG, through the full buildFailureReport() pipeline", async () => {
  const contextB = buildContext(PROFILE_B);
  const selectedB = selectKnowledge(contextB, combinedUnits);
  const fixedOverrides = { classification: "TEST_BUG", confidence: 0.8, shouldCreateBug: true };

  const report = await buildFailureReport(contextB, {
    provider: capturingProvider(fixedOverrides).provider,
    projectProfile: PROFILE_B,
    history: approvedHistoryB,
    relevantKnowledge: selectedB,
  });

  assert.equal(report.results[0].classification, "TEST_BUG");
  assert.equal(report.results[0].shouldCreateBug, false);
});
