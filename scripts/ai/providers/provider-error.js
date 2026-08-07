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

class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

module.exports = { ProviderError };
