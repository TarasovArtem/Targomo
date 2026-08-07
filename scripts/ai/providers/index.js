/**
 * Provider factory.
 *
 * createProvider() is the only thing analyze-failure.js imports from this
 * directory - it never touches mock-provider.js (or a real provider file
 * added later) directly. Adding a new provider means adding a new file
 * here plus one new `case` below; nothing outside scripts/ai/providers/
 * needs to change.
 */

"use strict";

const { MockProvider } = require("./mock-provider");
const { ProviderError } = require("./provider-error");
const { PROVIDER: RESOLVED_AI_PROVIDER } = require("../config");

// `providerName` defaults to config.js's resolved AI_PROVIDER (itself
// already defaulting to "mock" when unset) - passing it explicitly is
// mainly for tests, so they don't need to mutate process.env.
function createProvider(providerName = RESOLVED_AI_PROVIDER) {
  switch (providerName) {
    case "mock":
      return new MockProvider();
    default:
      // No silent fallback to a real provider for an unrecognized name -
      // that would hide a configuration mistake behind a call that looks
      // like it's using one provider while actually using another.
      throw new ProviderError(`Unsupported AI provider: ${providerName}`);
  }
}

module.exports = { createProvider };
