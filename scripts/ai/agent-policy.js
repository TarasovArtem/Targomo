/**
 * Application-owned action policy for QA Agent results.
 *
 * "LLM proposes. Application policy decides. Application executes." The
 * model's classification/shouldCreateBug are a recommendation, never an
 * authoritative action decision - this module is the one place that
 * decides whether a "create a product bug" recommendation is actually
 * allowed to survive into the final report. Only PRODUCT_BUG may keep a
 * true shouldCreateBug; every other classification is forced to false,
 * regardless of what the model suggested. PRODUCT_BUG itself is left
 * exactly as the model said - true stays true, false stays false - this
 * is a ceiling on which classifications MAY create a bug, not a floor
 * that turns every PRODUCT_BUG into an automatic bug filing (a future,
 * separate confidence-threshold policy, not this one).
 *
 * Called with an already-validateAnalysisItem()-passed result - this is
 * not a second validator, so it never re-checks confidence/evidence/
 * rootCause/recommendedFix/etc. It only reasons about the two fields its
 * own decision depends on.
 */

"use strict";

const { CLASSIFICATIONS } = require("./qa-agent-prompt");

// Checked against the live CLASSIFICATIONS list (rather than only trusting
// the literal string) so this breaks loudly instead of silently if that
// enum is ever changed - the same defensive pattern mock-provider.js uses
// for its own classification constant, so there is exactly one place in
// the codebase that hardcodes "PRODUCT_BUG" as a policy-relevant literal.
const PRODUCT_BUG_CLASSIFICATION = "PRODUCT_BUG";
if (!CLASSIFICATIONS.includes(PRODUCT_BUG_CLASSIFICATION)) {
  throw new Error(`agent-policy: "${PRODUCT_BUG_CLASSIFICATION}" is no longer a valid classification - update agent-policy.js.`);
}

// Pure, deterministic, provider-neutral: no network, no filesystem, no
// process.env, no knowledge of which provider produced `result`. Does not
// mutate its input - returns a new object, so a caller still holding the
// original result never sees it change out from under it.
function applyAgentPolicy(result) {
  const originalShouldCreateBug = result.shouldCreateBug;
  const finalShouldCreateBug = result.classification === PRODUCT_BUG_CLASSIFICATION ? originalShouldCreateBug : false;

  return {
    ...result,
    shouldCreateBug: finalShouldCreateBug,
    // Application-owned observability metadata, computed here from the
    // already-validated classification/shouldCreateBug. Deliberately
    // never reads `result.policy` even if the input already had one - an
    // LLM (or anything upstream) has no authority over this field, so
    // this always overwrites whatever was there rather than trusting it.
    policy: {
      adjusted: finalShouldCreateBug !== originalShouldCreateBug,
      originalShouldCreateBug,
    },
  };
}

module.exports = { applyAgentPolicy };
