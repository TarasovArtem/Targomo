/**
 * Single source of truth for AI provider configuration.
 *
 * Provider-neutral by design: analyze-failure.js never reads an endpoint
 * URL, request format, header, or auth scheme directly - only which
 * provider to use (AI_PROVIDER) and the two values a real provider
 * implementation may need once one is added (AI_MODEL, AI_API_KEY).
 * scripts/ai/providers/ owns everything provider-specific.
 */

"use strict";

// Selects which implementation scripts/ai/providers/index.js's
// createProvider() returns. "mock" (the default) performs no network
// requests - safe for CI, local development, and tests with no external
// dependency, secret, or cost. There is no fallback to a real provider:
// an unrecognized value is a configuration mistake to fail loudly on, not
// something to silently paper over.
const DEFAULT_PROVIDER = "mock";
const PROVIDER = process.env.AI_PROVIDER || DEFAULT_PROVIDER;

// Provider-specific model id (e.g. a future real provider's own catalog
// format). Unused by MockProvider; centralized here so a real provider
// reads it from one place rather than each hardcoding its own default.
const DEFAULT_MODEL = null;
const MODEL = process.env.AI_MODEL || DEFAULT_MODEL;

// Provider-specific credential. Never required for AI_PROVIDER=mock - a
// real provider implementation is responsible for validating its own
// presence (and never logging it) once one exists.
const API_KEY = process.env.AI_API_KEY || null;

module.exports = { PROVIDER, DEFAULT_PROVIDER, MODEL, DEFAULT_MODEL, API_KEY };
