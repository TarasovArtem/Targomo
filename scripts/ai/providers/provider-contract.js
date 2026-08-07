/**
 * Runtime checks for the provider boundary.
 *
 * The provider contract (provider.analyze({systemPrompt, userPrompt}) ->
 * Promise<string>) is not enforced by any type system in this project, so
 * it's enforced here instead, at the two points where an untrusted value
 * crosses into analyze-failure.js: the provider object itself, and the
 * string it eventually resolves with. No schema library - both checks are
 * a handful of lines of plain JavaScript.
 */

"use strict";

const { ProviderError, PROVIDER_ERROR_CODES } = require("./provider-error");

// Catches a provider implementation that forgot analyze(), or any object
// that isn't a provider at all, with one clear error instead of a
// "provider.analyze is not a function" TypeError surfacing from deep
// inside the retry loop.
function validateProvider(provider) {
  if (!provider || typeof provider.analyze !== "function") {
    throw new ProviderError("Invalid AI provider: analyze() function is required", {
      code: PROVIDER_ERROR_CODES.CONFIGURATION,
      retryable: false,
    });
  }
}

// A provider's analyze() promise resolving successfully is not the same as
// it having returned something usable - null/undefined/an object/an empty
// or whitespace-only string are all "the provider didn't give us anything
// to parse", not the JSON string the contract promises, and must never
// reach JSON.parse directly.
function validateProviderResponse(response) {
  if (typeof response !== "string") {
    throw new ProviderError("AI provider returned an invalid response type", {
      code: PROVIDER_ERROR_CODES.INVALID_RESPONSE,
      retryable: false,
    });
  }
  if (response.trim().length === 0) {
    throw new ProviderError("AI provider returned an empty response", {
      code: PROVIDER_ERROR_CODES.INVALID_RESPONSE,
      retryable: false,
    });
  }
}

module.exports = { validateProvider, validateProviderResponse };
