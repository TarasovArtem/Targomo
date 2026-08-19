/**
 * GeminiProvider - talks to Google's native Gemini REST API
 * (generateContent), not the Google GenAI SDK.
 *
 * Scope is deliberately narrow, mirroring groq-provider.js exactly:
 * configuration -> HTTP request -> Gemini API -> HTTP/network error mapping
 * -> extract the model's raw text output. Nothing here parses that text as
 * JSON, validates a classification, or knows anything about the QA report
 * schema - that stays in analyze-failure.js, exactly as it does for
 * GroqProvider/MockProvider. This file is the only place in the project
 * that knows Gemini's endpoint URL, request shape, or auth header.
 *
 * No responseMimeType/responseSchema (Gemini's native structured-output
 * mode) is requested: the system prompt (qa-agent-prompt.js) already
 * demands raw JSON, and analyze-failure.js already strips an accidental
 * markdown fence - the same provider-neutral fallbacks Groq relies on,
 * kept identical here so both real providers exercise the exact same core
 * parsing path (Roadmap #18.5/#18.6).
 */

"use strict";

const { ProviderError, PROVIDER_ERROR_CODES } = require("./provider-error");
const { API_KEY, MODEL } = require("../config");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT_MS = 30000;

// HTTP status -> generic ProviderError code/retryable. Deliberately no
// Gemini-specific codes - only the shared, provider-neutral
// PROVIDER_ERROR_CODES vocabulary analyze-failure.js already understands,
// exactly mirroring groq-provider.js's mapHttpError() structure. Gemini's
// documented status codes (400/401/403/404/409/416/429/499/500/501/503/504)
// fold into the same four buckets Groq's own mapping already uses - no new
// TIMEOUT-via-HTTP-status case is introduced (Gemini does not document a
// 408; TIMEOUT here only ever comes from this adapter's own AbortController,
// same as Groq).
function mapHttpError(status) {
  if (status === 401 || status === 403) {
    return new ProviderError(`Gemini API authentication failed (HTTP ${status})`, {
      code: PROVIDER_ERROR_CODES.AUTH,
      retryable: false,
    });
  }
  if (status === 429) {
    return new ProviderError(`Gemini API rate limit exceeded (HTTP ${status})`, {
      code: PROVIDER_ERROR_CODES.RATE_LIMIT,
      retryable: true,
    });
  }
  if (status >= 500 && status <= 599) {
    return new ProviderError(`Gemini API server error (HTTP ${status})`, {
      code: PROVIDER_ERROR_CODES.UNKNOWN,
      retryable: true,
    });
  }
  // Any other 4xx (400/404/409/416/499): a request-shape problem that will
  // fail identically on retry.
  return new ProviderError(`Gemini API request failed (HTTP ${status})`, {
    code: PROVIDER_ERROR_CODES.UNKNOWN,
    retryable: false,
  });
}

// Gemini's response splits model output across zero or more "parts" inside
// a single candidate's content - in ordinary (non-tool, non-thinking)
// text-only usage there is normally exactly one text part, but the
// envelope always allows more than one. Deterministic, documented-shape
// strategy: concatenate every part that carries a `text` string, in the
// array's own order, with no separator - the parts together represent one
// continuous response, not separate messages. A part without a `text`
// field (a future non-text part type this adapter never requests, e.g. a
// function call) is simply skipped, never coerced into a string. Returns
// null (not "") when there is no usable text at all, so the caller can
// distinguish "no text" from "empty text" without extra bookkeeping.
function extractText(body) {
  const candidate = body && Array.isArray(body.candidates) && body.candidates[0];
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const textParts = parts.filter((p) => p && typeof p.text === "string").map((p) => p.text);
  if (textParts.length === 0) return null;
  const joined = textParts.join("");
  return joined.trim().length > 0 ? joined : null;
}

class GeminiProvider {
  name = "gemini";

  // Dependency injection, not environment reads inside analyze(): lets unit
  // tests construct a fully offline GeminiProvider (fake fetchImpl, a
  // throwaway key/model, a short timeoutMs) with no process.env
  // manipulation and no real network access - identical pattern to
  // GroqProvider. Production (createProvider(), see providers/index.js)
  // calls `new GeminiProvider()` with no arguments, which falls back to
  // this project's existing generic config (AI_API_KEY, AI_MODEL) -
  // GeminiProvider never introduces a GEMINI_-prefixed env var of its own.
  constructor({ apiKey = API_KEY, model = MODEL, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) {
      throw new ProviderError('AI_API_KEY is required for provider "gemini"', {
        code: PROVIDER_ERROR_CODES.CONFIGURATION,
        retryable: false,
      });
    }
    if (!model) {
      throw new ProviderError('AI_MODEL is required for provider "gemini"', {
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

    // Model belongs in the URL path (Gemini's own REST convention), never
    // hardcoded - always the configured this.model, so a future AI_MODEL
    // change requires no adapter change.
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(this.model)}:generateContent`;

    let res;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // systemPrompt/userPrompt stay semantically separate, exactly as
          // core (qa-agent-prompt.js) built them - no rewriting, no
          // merging into a single blob. systemInstruction is Gemini's own
          // dedicated field for this, not a message role.
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // AbortController firing (our own timeout) vs. any other fetch
      // failure (DNS, connection reset, TLS, etc.) are different generic
      // codes even though both surface as a thrown error from fetch() -
      // identical distinction to GroqProvider.
      if (err && err.name === "AbortError") {
        throw new ProviderError(`Gemini API request timed out after ${this.timeoutMs}ms`, {
          code: PROVIDER_ERROR_CODES.TIMEOUT,
          retryable: true,
          cause: err,
        });
      }
      throw new ProviderError(`Gemini API request failed: ${(err && err.message) || "network error"}`, {
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
      throw new ProviderError("Gemini API returned a response that was not valid JSON", {
        code: PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        retryable: false,
        cause: err,
      });
    }

    // Covers every "no usable text" shape uniformly (missing candidates,
    // empty candidates array, missing content, empty parts, parts with no
    // text field - e.g. a safety block or any other non-text-only
    // response) - the caller does not need to know *why* there is no text,
    // only that there isn't any.
    const content = extractText(body);
    if (content === null) {
      throw new ProviderError("Gemini API response did not include any model content", {
        code: PROVIDER_ERROR_CODES.INVALID_RESPONSE,
        retryable: false,
      });
    }

    return content;
  }
}

module.exports = { GeminiProvider };
