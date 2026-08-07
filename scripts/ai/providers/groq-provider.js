/**
 * GroqProvider - talks to Groq's OpenAI-compatible Chat Completions API.
 *
 * Scope is deliberately narrow: configuration -> HTTP request -> Groq API
 * -> HTTP/network error mapping -> extract the model's raw text output.
 * Nothing here parses that text as JSON, validates a classification, or
 * knows anything about the QA report schema - that stays in
 * analyze-failure.js, exactly as it does for MockProvider. This file is
 * the only place in the project that knows Groq's endpoint URL, request
 * shape, or auth header.
 *
 * No response_format / JSON mode is requested: Groq JSON-mode support
 * varies by model and isn't something to guess at without calling the
 * real API, which this stage intentionally does not do. The system prompt
 * (qa-agent-prompt.js) already demands raw JSON, and analyze-failure.js
 * already strips an accidental markdown fence - both provider-neutral
 * fallbacks that work whether or not a future model change adds JSON mode.
 */

"use strict";

const { ProviderError, PROVIDER_ERROR_CODES } = require("./provider-error");
const { API_KEY, MODEL } = require("../config");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 30000;

// HTTP status -> generic ProviderError code/retryable. Deliberately no
// Groq-specific codes (e.g. "GROQ_RATE_LIMIT") - only the shared,
// provider-neutral PROVIDER_ERROR_CODES vocabulary analyze-failure.js
// already understands.
function mapHttpError(status) {
  if (status === 401 || status === 403) {
    return new ProviderError(`Groq API authentication failed (HTTP ${status})`, {
      code: PROVIDER_ERROR_CODES.AUTH,
      retryable: false,
    });
  }
  if (status === 429) {
    return new ProviderError(`Groq API rate limit exceeded (HTTP ${status})`, {
      code: PROVIDER_ERROR_CODES.RATE_LIMIT,
      retryable: true,
    });
  }
  if (status === 408) {
    return new ProviderError(`Groq API request timed out (HTTP ${status})`, {
      code: PROVIDER_ERROR_CODES.TIMEOUT,
      retryable: true,
    });
  }
  if (status >= 500 && status <= 599) {
    return new ProviderError(`Groq API server error (HTTP ${status})`, {
      code: PROVIDER_ERROR_CODES.UNKNOWN,
      retryable: true,
    });
  }
  // Any other 4xx: a request-shape problem that will fail identically on
  // retry (not authentication, not rate limiting, not a 408).
  return new ProviderError(`Groq API request failed (HTTP ${status})`, {
    code: PROVIDER_ERROR_CODES.UNKNOWN,
    retryable: false,
  });
}

class GroqProvider {
  name = "groq";

  // Dependency injection, not environment reads inside analyze(): lets
  // unit tests construct a fully offline GroqProvider (fake fetchImpl, a
  // throwaway key/model, a short timeoutMs) with no process.env
  // manipulation and no real network access. Production (createProvider(),
  // see providers/index.js) calls `new GroqProvider()` with no arguments,
  // which falls back to this project's existing generic config (AI_API_KEY,
  // AI_MODEL) - GroqProvider never introduces a GROQ_-prefixed env var of
  // its own.
  constructor({ apiKey = API_KEY, model = MODEL, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) {
      throw new ProviderError('AI_API_KEY is required for provider "groq"', {
        code: PROVIDER_ERROR_CODES.CONFIGURATION,
        retryable: false,
      });
    }
    if (!model) {
      throw new ProviderError('AI_MODEL is required for provider "groq"', {
        code: PROVIDER_ERROR_CODES.CONFIGURATION,
        retryable: false,
      });
    }

    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async analyze({ systemPrompt, userPrompt }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await this.fetchImpl(GROQ_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // AbortController firing (our own timeout) vs. any other fetch
      // failure (DNS, connection reset, TLS, etc.) are different generic
      // codes even though both surface as a thrown error from fetch() -
      // only the timeout case is a controller.abort() we triggered
      // ourselves.
      if (err && err.name === "AbortError") {
        throw new ProviderError(`Groq API request timed out after ${this.timeoutMs}ms`, {
          code: PROVIDER_ERROR_CODES.TIMEOUT,
          retryable: true,
          cause: err,
        });
      }
      throw new ProviderError(`Groq API request failed: ${(err && err.message) || "network error"}`, {
        code: PROVIDER_ERROR_CODES.NETWORK,
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw mapHttpError(res.status);
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new ProviderError("Groq API returned a response that was not valid JSON", {
        code: PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        retryable: false,
        cause: err,
      });
    }

    // Only checking that the envelope actually contains textual model
    // output - not what that text says. Whether it's valid JSON, a QA
    // report, or nonsense is analyze-failure.js's job to determine next.
    const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ProviderError("Groq API response did not include any model content", {
        code: PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        retryable: false,
      });
    }

    return content;
  }
}

module.exports = { GroqProvider };
