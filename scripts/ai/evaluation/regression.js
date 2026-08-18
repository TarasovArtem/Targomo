/**
 * Deterministic, offline regression comparator: compares a current
 * evaluateDataset() result (scoring.js) against the frozen Baseline v1
 * (baseline-v1.json) on a PER-SAMPLE basis.
 *
 * Why per-sample and not aggregate accuracy: aggregate accuracy can stay
 * identical while the actual set of right/wrong samples shifts (one
 * previously-correct sample breaks while a previously-wrong one gets
 * fixed) - that is a real regression a global percentage would hide. See
 * compareEvaluationToBaseline()'s mandatory test coverage in
 * regression.test.js for the exact scenario this guards against.
 *
 * compareEvaluationToBaseline() is pure/deterministic/offline: no
 * filesystem, no environment variables, no network - same discipline as
 * scoring.js. run()/main() below are the only I/O-touching parts, and they
 * reuse validateDataset()/evaluateDataset() rather than re-implementing any
 * scoring logic.
 *
 * Protects seven dimensions per sample (Roadmap #12 added the last three):
 * classification, shouldRetry, shouldCreateBug, fabricatedEvidence,
 * rootCause, evidence, recommendedFix. rootCause/evidence/recommendedFix use
 * the same fail<partial<pass ordering (with not_applicable outside that
 * ordering) already established for correlation quality in
 * regression-v2.js/regression-v3.js - any regression on any dimension, for
 * any sample, still outweighs any number of simultaneous improvements.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { validateDataset } = require("./dataset-schema");
const { validateBaseline } = require("./baseline-schema");
const { evaluateDataset } = require("./scoring");

const DEFAULT_DATASET_PATH = path.join(__dirname, "dataset.json");
const DEFAULT_BASELINE_PATH = path.join(__dirname, "baseline-v1.json");

const QUALITY_RANK = { fail: 0, partial: 1, pass: 2 };
const QUALITATIVE_DIMENSIONS = ["rootCause", "evidence", "recommendedFix"];

// scoring.js's per-sample classification.status ("correct"/"incorrect"/
// "ambiguous") uses different words than the baseline's classificationStatus
// vocabulary ("pass"/"fail"/"ambiguous") - this is the one place that maps
// between them, so the two vocabularies can evolve independently.
function toBaselineClassificationStatus(scoringStatus) {
  if (scoringStatus === "correct") return "pass";
  if (scoringStatus === "incorrect") return "fail";
  return "ambiguous";
}

// baselineCorrect/currentCorrect booleans -> "regression" | "improvement" |
// "unchanged". Shared by shouldRetry and shouldCreateBug, which both follow
// the identical true/false transition rules (Steps 14/15).
function compareCorrectness(baselineCorrect, currentCorrect) {
  if (baselineCorrect === true && currentCorrect === false) return "regression";
  if (baselineCorrect === false && currentCorrect === true) return "improvement";
  return "unchanged";
}

// fabricatedEvidence is the mirror-image polarity of compareCorrectness:
// false ("no fabricated/unsupported evidence finding") is the good state, so
// false -> true is the regression, not true -> false. A dedicated function
// (rather than calling compareCorrectness with flipped arguments) keeps that
// polarity explicit at the call site instead of relying on the reader to
// remember to invert it.
function compareFabricatedEvidence(baselineValue, currentValue) {
  if (baselineValue === false && currentValue === true) return "regression";
  if (baselineValue === true && currentValue === false) return "improvement";
  return "unchanged";
}

// Roadmap #12: shared ordering for the three qualitative dimensions
// (rootCause/evidence/recommendedFix) - fail(0) < partial(1) < pass(2), with
// not_applicable outside that ordering entirely. Identical semantics to the
// correlation-quality comparator already established in regression-v2.js/
// regression-v3.js: both sides not_applicable is "unchanged"; either side
// (but not both) being not_applicable is "informational", never silently
// scored as a quality regression or improvement.
function compareQualityTernary(baselineValue, currentValue) {
  if (baselineValue === "not_applicable" && currentValue === "not_applicable") return "unchanged";
  if (baselineValue === "not_applicable" || currentValue === "not_applicable") return "informational";

  const baselineRank = QUALITY_RANK[baselineValue];
  const currentRank = QUALITY_RANK[currentValue];
  if (currentRank > baselineRank) return "improvement";
  if (currentRank < baselineRank) return "regression";
  return "unchanged";
}

function compareClassification(baselineStatus, currentStatus) {
  // Conservative v1 rule: if either side is "ambiguous", the classification
  // dimension for this sample is informational only and never drives the
  // top-level status. Experiment #5-style boundary cases are curated
  // judgment calls, not a stable pass/fail signal - letting them flip
  // IMPROVED/REGRESSED would make the gate hostage to subjective ambiguity
  // curation rather than to genuine classification drift.
  if (baselineStatus === "ambiguous" || currentStatus === "ambiguous") return "informational";
  if (baselineStatus === "pass" && currentStatus === "pass") return "unchanged";
  if (baselineStatus === "pass" && currentStatus === "fail") return "regression";
  if (baselineStatus === "fail" && currentStatus === "pass") return "improvement";
  // fail -> fail: a known baseline deficiency that is still wrong is not a
  // NEW regression - it was already wrong when the baseline was frozen.
  return "unchanged";
}

// Pure function: { metrics, samples } (evaluateDataset() output) + an
// already-validated baseline object in, a structured comparison out. Never
// reads dataset.json/baseline-v1.json itself and never decides whether
// either input is well-formed - that's dataset-schema.js/baseline-schema.js's
// job, and run() below's responsibility to call before this ever runs.
function compareEvaluationToBaseline(currentEvaluation, baseline) {
  const baselineIds = Object.keys(baseline.samples).sort();
  const currentIds = currentEvaluation.samples.map((s) => s.id).sort();
  const sameSampleSet = baselineIds.length === currentIds.length && baselineIds.every((id, index) => id === currentIds[index]);

  if (!sameSampleSet) {
    const missingFromCurrent = baselineIds.filter((id) => !currentIds.includes(id));
    const missingFromBaseline = currentIds.filter((id) => !baselineIds.includes(id));
    return {
      status: "BASELINE_MISMATCH",
      errors: [
        ...missingFromCurrent.map((id) => `sample "${id}" is in the baseline but missing from the current evaluation`),
        ...missingFromBaseline.map((id) => `sample "${id}" is in the current evaluation but missing from the baseline`),
      ],
      summary: null,
      samples: [],
    };
  }

  const samples = [];
  let regressions = 0;
  let improvements = 0;
  let unchanged = 0;
  let informational = 0;

  const tally = (change) => {
    if (change === "regression") regressions += 1;
    else if (change === "improvement") improvements += 1;
    else if (change === "informational") informational += 1;
    else unchanged += 1;
  };

  for (const currentSample of currentEvaluation.samples) {
    const baselineSample = baseline.samples[currentSample.id];
    const currentClassificationStatus = toBaselineClassificationStatus(currentSample.classification.status);
    const baselineClassificationStatus = baselineSample.classificationStatus;

    const classificationChange = compareClassification(baselineClassificationStatus, currentClassificationStatus);
    // shouldRetry/shouldCreateBug apply to EVERY sample regardless of
    // ambiguity - action safety is independent of classification ambiguity
    // (Steps 14/15), so these two never go through the informational path.
    const shouldRetryChange = compareCorrectness(baselineSample.shouldRetryCorrect, currentSample.shouldRetry.correct);
    const shouldCreateBugChange = compareCorrectness(baselineSample.shouldCreateBugCorrect, currentSample.shouldCreateBug.correct);
    const fabricatedEvidenceChange = compareFabricatedEvidence(baselineSample.fabricatedEvidence, currentSample.quality.fabricatedEvidence);

    // Roadmap #12: rootCause/evidence/recommendedFix, per sample, using the
    // same fail<partial<pass ordering as correlation quality elsewhere.
    const qualitativeChanges = {};
    for (const dimension of QUALITATIVE_DIMENSIONS) {
      qualitativeChanges[dimension] = compareQualityTernary(baselineSample[dimension], currentSample.quality[dimension]);
    }

    for (const change of [classificationChange, shouldRetryChange, shouldCreateBugChange, fabricatedEvidenceChange, ...Object.values(qualitativeChanges)]) {
      tally(change);
    }

    samples.push({
      id: currentSample.id,
      classification: {
        baseline: baselineClassificationStatus,
        current: currentClassificationStatus,
        change: classificationChange,
      },
      shouldRetry: {
        baselineCorrect: baselineSample.shouldRetryCorrect,
        currentCorrect: currentSample.shouldRetry.correct,
        change: shouldRetryChange,
      },
      shouldCreateBug: {
        baselineCorrect: baselineSample.shouldCreateBugCorrect,
        currentCorrect: currentSample.shouldCreateBug.correct,
        change: shouldCreateBugChange,
      },
      fabricatedEvidence: {
        baseline: baselineSample.fabricatedEvidence,
        current: currentSample.quality.fabricatedEvidence,
        change: fabricatedEvidenceChange,
      },
      rootCause: {
        baseline: baselineSample.rootCause,
        current: currentSample.quality.rootCause,
        change: qualitativeChanges.rootCause,
      },
      evidence: {
        baseline: baselineSample.evidence,
        current: currentSample.quality.evidence,
        change: qualitativeChanges.evidence,
      },
      recommendedFix: {
        baseline: baselineSample.recommendedFix,
        current: currentSample.quality.recommendedFix,
        change: qualitativeChanges.recommendedFix,
      },
    });
  }

  // Precedence is deliberately safety-first: a single regression anywhere
  // outweighs any number of simultaneous improvements. 1 improvement + 1
  // regression is REGRESSED, never a wash (Step 11/Step 27).
  const status = regressions > 0 ? "REGRESSED" : improvements > 0 ? "IMPROVED" : "UNCHANGED";

  return {
    status,
    summary: { improvements, regressions, unchanged, informational },
    samples,
  };
}

function formatRegressionReport(comparison) {
  const lines = ["QA Agent Regression Check — Baseline v1", ""];

  if (comparison.status === "BASELINE_MISMATCH") {
    lines.push("Status: BASELINE_MISMATCH", "", "Errors:");
    for (const error of comparison.errors) lines.push(`  - ${error}`);
    return lines.join("\n");
  }

  lines.push(`Status: ${comparison.status}`, "", "Improvements:", `  ${comparison.summary.improvements}`, "", "Regressions:", `  ${comparison.summary.regressions}`);

  const regressionDetails = [];
  const improvementDetails = [];
  const knownDeficiencies = [];
  const ambiguousIds = [];

  for (const sample of comparison.samples) {
    for (const dimension of ["classification", "shouldRetry", "shouldCreateBug", "fabricatedEvidence", "rootCause", "evidence", "recommendedFix"]) {
      const change = sample[dimension].change;
      if (change === "regression") regressionDetails.push(`${sample.id} ${dimension}`);
      if (change === "improvement") improvementDetails.push(`${sample.id} ${dimension}`);
    }
    if (sample.classification.change === "unchanged" && sample.classification.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} classification`);
    }
    if (sample.shouldRetry.change === "unchanged" && sample.shouldRetry.baselineCorrect === false) {
      knownDeficiencies.push(`${sample.id} shouldRetry`);
    }
    if (sample.shouldCreateBug.change === "unchanged" && sample.shouldCreateBug.baselineCorrect === false) {
      knownDeficiencies.push(`${sample.id} shouldCreateBug`);
    }
    if (sample.fabricatedEvidence.change === "unchanged" && sample.fabricatedEvidence.baseline === true) {
      knownDeficiencies.push(`${sample.id} fabricatedEvidence`);
    }
    // Roadmap #12: same "unchanged and already at the worst state" known-
    // deficiency convention as classification (baseline === "fail"), not
    // "partial" - a partial baseline was never flagged as a deficiency for
    // any existing dimension either, so this stays consistent rather than
    // inventing a new threshold.
    if (sample.rootCause.change === "unchanged" && sample.rootCause.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} rootCause`);
    }
    if (sample.evidence.change === "unchanged" && sample.evidence.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} evidence`);
    }
    if (sample.recommendedFix.change === "unchanged" && sample.recommendedFix.baseline === "fail") {
      knownDeficiencies.push(`${sample.id} recommendedFix`);
    }
    if (sample.classification.baseline === "ambiguous" || sample.classification.current === "ambiguous") {
      ambiguousIds.push(sample.id);
    }
  }

  if (regressionDetails.length > 0) {
    lines.push("", "Regression details:");
    for (const detail of regressionDetails) lines.push(`  - ${detail}`);
  }
  if (improvementDetails.length > 0) {
    lines.push("", "Improvement details:");
    for (const detail of improvementDetails) lines.push(`  - ${detail}`);
  }
  if (knownDeficiencies.length > 0) {
    lines.push("", "Known deficiencies:");
    for (const deficiency of knownDeficiencies) lines.push(`  - ${deficiency}`);
  }
  if (ambiguousIds.length > 0) {
    lines.push("", "Ambiguous:");
    for (const id of ambiguousIds) lines.push(`  - ${id}`);
  }

  return lines.join("\n");
}

// Testable core: no console.log/process.exit, just inputs to outputs.
function run(datasetPath, baselinePath) {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const datasetValidation = validateDataset(dataset);
  if (!datasetValidation.valid) {
    const output = ["Dataset v1 failed validation:", ...datasetValidation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const baselineValidation = validateBaseline(baseline);
  if (!baselineValidation.valid) {
    const output = ["Baseline v1 failed validation:", ...baselineValidation.errors.map((e) => `  - ${e}`)].join("\n");
    return { exitCode: 1, output };
  }

  const currentEvaluation = evaluateDataset(dataset);
  const comparison = compareEvaluationToBaseline(currentEvaluation, baseline);

  // A sample-set mismatch means the baseline can't safely be compared at
  // all - report it as a real failure, not as a REGRESSED/IMPROVED verdict.
  if (comparison.status === "BASELINE_MISMATCH") {
    return { exitCode: 1, output: formatRegressionReport(comparison) };
  }

  // Phase 3 is offline/informational only - this PR adds no CI gate, so
  // even a REGRESSED status exits 0 here. A later CI integration may map
  // REGRESSED to a non-zero exit; that mapping is deliberately not made yet.
  return { exitCode: 0, output: formatRegressionReport(comparison) };
}

function main() {
  const result = run(DEFAULT_DATASET_PATH, DEFAULT_BASELINE_PATH);
  if (result.exitCode === 0) {
    console.log(result.output);
  } else {
    console.error(result.output);
  }
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main();
}

module.exports = { compareEvaluationToBaseline, formatRegressionReport, run };
