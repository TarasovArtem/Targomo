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
 * analysis happened, rather than fabricating a plausible-looking one. Not
 * a fake AI engine: it never inspects failure evidence to guess a
 * classification (that would make its stub output misleadingly
 * convincing) - it exists purely for contract/pipeline testing and as a
 * safe CI default.
 *
 * Also doubles as the project's provider test double: the constructor's
 * `mode` option lets unit tests deterministically exercise the success,
 * retryable-error, non-retryable-error, and invalid-response paths through
 * runProviderAnalysis without needing a second, throwaway fake provider
 * class per test file.
 */

"use strict";

const { CLASSIFICATIONS } = require("../qa-agent-prompt");
const { ProviderError, PROVIDER_ERROR_CODES } = require("./provider-error");

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
    // Deliberately empty, not e.g. ["Analysis was produced by MockProvider."]:
    // evidence describes facts about the failure under analysis, and
    // MockProvider examined none. Which provider ran is infrastructure
    // metadata - the application attaches that separately (see
    // analyze-failure.js's report.analysis), not the model/provider itself.
    evidence: [],
    recommendedFix: {
      file: null,
      description: "Configure a real AI provider when ready.",
    },
    shouldCreateBug: false,
    shouldRetry: false,
  };
}

class MockProvider {
  // Read by analyze-failure.js for report.analysis.provider and by any
  // future diagnostics/PR-comment code that wants to say which provider
  // ran - a plain string property rather than a method, since it never
  // needs to be async or take arguments.
  name = "mock";

  // options:
  //   mode: "success" (default) | "error" | "invalid-response"
  //   error: the Error/ProviderError to throw when mode is "error"
  //          (defaults to a generic non-retryable ProviderError)
  //   response: the value to resolve analyze() with when mode is
  //             "invalid-response" (e.g. "", "   ", null, {})
  // Dependency injection instead of an env var, so tests can construct
  // exactly the provider behavior they want without touching process.env -
  // createProvider() with no options still always produces today's safe,
  // successful default.
  constructor(options = {}) {
    this.mode = options.mode || "success";
    this.error = options.error || null;
    this.response = options.response;
  }

  async analyze({ userPrompt } = {}) {
    if (this.mode === "error") {
      throw (
        this.error ||
        new ProviderError("MockProvider: simulated provider failure", {
          code: PROVIDER_ERROR_CODES.UNKNOWN,
          retryable: false,
        })
      );
    }

    if (this.mode === "invalid-response") {
      return this.response;
    }

    const failedTests = extractFailedTests(userPrompt);
    const results = (failedTests.length > 0 ? failedTests : [null]).map(buildMockResult);
    return JSON.stringify({ results });
  }
}

module.exports = { MockProvider };
