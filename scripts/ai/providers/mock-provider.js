/**
 * MockProvider - the default AI provider.
 *
 * Performs NO network requests, ever. Used for local development, unit
 * tests, and (until a real provider is chosen) GitHub Actions runs - the
 * full QA Agent pipeline (context -> prompt -> provider -> parse ->
 * validate -> report -> PR comment) can be exercised end to end with no
 * external dependency, secret, or cost.
 *
 * Returns a schema-valid JSON string honestly describing that no real
 * analysis happened, rather than fabricating a plausible-looking one.
 */

"use strict";

const { CLASSIFICATIONS } = require("../qa-agent-prompt");

// UNKNOWN is the project's existing, correct vocabulary for "insufficient
// evidence to classify" - here what's missing is a real AI provider, not
// test evidence. Checked against the live CLASSIFICATIONS list (rather
// than only trusting the literal string) so this breaks loudly instead of
// silently if that enum is ever changed.
const MOCK_CLASSIFICATION = "UNKNOWN";
if (!CLASSIFICATIONS.includes(MOCK_CLASSIFICATION)) {
  throw new Error(`MockProvider: "${MOCK_CLASSIFICATION}" is no longer a valid classification - update mock-provider.js.`);
}

// The system/user prompt split is provider-agnostic; MockProvider ignores
// systemPrompt entirely and only reads the "failedTests" list out of
// userPrompt's fenced JSON block (the same payload qa-agent-prompt.js's
// buildUserPrompt produces) so it can return one honest result per failed
// test, exactly like a real provider would - not just one hardcoded item
// regardless of how many tests actually failed.
function extractFailedTests(userPrompt) {
  const match = typeof userPrompt === "string" && userPrompt.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return [];
  try {
    const payload = JSON.parse(match[1]);
    return Array.isArray(payload.failedTests) ? payload.failedTests : [];
  } catch {
    return [];
  }
}

function buildMockResult(failedTest) {
  return {
    test: {
      title: (failedTest && failedTest.title) || "Mock failed test",
      specFile: (failedTest && failedTest.specFile) || null,
    },
    classification: MOCK_CLASSIFICATION,
    confidence: 0.5,
    summary: "Mock AI analysis.",
    rootCause: "No real AI provider is configured (AI_PROVIDER=mock).",
    evidence: ["Analysis was produced by MockProvider."],
    recommendedFix: {
      file: null,
      description: "Configure a real AI provider when ready.",
    },
    shouldCreateBug: false,
    shouldRetry: false,
  };
}

class MockProvider {
  async analyze({ userPrompt } = {}) {
    const failedTests = extractFailedTests(userPrompt);
    const results = (failedTests.length > 0 ? failedTests : [null]).map(buildMockResult);
    return JSON.stringify({ results });
  }
}

module.exports = { MockProvider };
