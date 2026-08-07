/**
 * Common error shape for AI provider implementations.
 *
 * Kept deliberately simple - no error hierarchy, just one class every
 * provider (mock, and real ones added later) can throw so callers have a
 * single, provider-neutral way to tell "was this worth retrying" apart
 * from "this will fail the same way every time", without needing to know
 * which provider or HTTP status produced it.
 */

"use strict";

// Generic, provider-neutral categories. A future real provider translates
// its own specific errors (e.g. an HTTP 429, a Groq-specific rate-limit
// body, a fetch AbortError from its own timeout) into one of these - never
// its own bespoke code string - so analyze-failure.js only ever has to
// reason about this fixed, small set regardless of which provider is
// active. CONFIGURATION is also what a provider's own constructor/analyze()
// should throw for a provider-specific setup problem (e.g. a real provider
// requiring its own API key) - see config.js's AI_API_KEY.
const PROVIDER_ERROR_CODES = Object.freeze({
  AUTH: "AUTH",
  RATE_LIMIT: "RATE_LIMIT",
  TIMEOUT: "TIMEOUT",
  NETWORK: "NETWORK",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  CONFIGURATION: "CONFIGURATION",
  UNKNOWN: "UNKNOWN",
});

class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    // Preserves the original error (e.g. a real provider's underlying
    // fetch/network exception) for debugging without leaking it into the
    // message shown to the user - callers read err.message/err.code, never
    // err.cause, for anything user-facing.
    this.cause = options.cause;
  }
}

// Ensures analyze-failure.js's retry/report logic only ever has to handle
// one error shape (ProviderError), regardless of whether a provider threw
// one itself or let some other exception (a bug, an unexpected network
// library error, etc.) escape. Idempotent: a ProviderError passed in comes
// back unchanged, with none of its metadata lost.
function normalizeProviderError(error) {
  if (error instanceof ProviderError) return error;
  const message = (error && error.message) || "Unknown AI provider error";
  return new ProviderError(message, {
    code: PROVIDER_ERROR_CODES.UNKNOWN,
    retryable: false,
    cause: error,
  });
}

module.exports = { ProviderError, PROVIDER_ERROR_CODES, normalizeProviderError };
