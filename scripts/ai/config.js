/**
 * Single source of truth for AI provider configuration.
 *
 * The QA Agent was built to talk to GitHub Models
 * (https://docs.github.com/en/github-models), authenticated with the same
 * GITHUB_TOKEN every GitHub Actions run already has - no separate API key,
 * account, or billing setup. Every other scripts/ai/*.js file imports
 * MODEL/ENDPOINT from here rather than hardcoding either, so changing
 * providers or models is a one-line change in one file.
 *
 * PROVIDER_PAUSED_REASON (see below): GitHub Models was fully retired by
 * GitHub on 2026-07-30 - confirmed live, the inference endpoint now
 * returns HTTP 410 Gone for every request
 * (https://github.blog/changelog/2026-07-30-github-models-is-now-retired/).
 * The transport code below (callGitHubModels in analyze-failure.js) is
 * left in place, tested, and ready to point at a replacement provider -
 * only the endpoint/auth details and this flag need to change once one is
 * chosen. Until then, analyze-failure.js short-circuits before making any
 * network call (see requirePausedCheck usage there) rather than retrying
 * a permanently dead endpoint on every failed CI run.
 */

"use strict";

// Overridable via the AI_MODEL environment variable (e.g. in the workflow:
// `env: AI_MODEL: openai/gpt-4o-mini`) without touching source code.
// openai/gpt-4o was GitHub Models' catalog id for OpenAI's GPT-4o - see
// https://github.com/marketplace/models for the (now-retired) catalog
// format reference. Kept as the default so the value is a one-line change
// once a replacement provider is wired up.
const DEFAULT_MODEL = "openai/gpt-4o";
const MODEL = process.env.AI_MODEL || DEFAULT_MODEL;

// GitHub Models inference endpoint - OpenAI-Chat-Completions-compatible,
// authenticated with `Authorization: Bearer <GITHUB_TOKEN>`. Retained for
// when a replacement provider's endpoint is chosen; not currently called
// (see PROVIDER_PAUSED_REASON).
const GITHUB_MODELS_ENDPOINT = "https://models.github.ai/inference/chat/completions";

// Non-null means "don't attempt an AI provider call - short-circuit with a
// clear, visible stub instead". Set back to null (and update MODEL/
// GITHUB_MODELS_ENDPOINT above, and the request shape in
// analyze-failure.js's callGitHubModels if the new provider isn't
// Chat-Completions-compatible) once a replacement provider is chosen.
const PROVIDER_PAUSED_REASON =
  "GitHub Models was retired on 2026-07-30 and its inference API now returns HTTP 410 Gone for every request " +
  "(https://github.blog/changelog/2026-07-30-github-models-is-now-retired/). No replacement AI provider is " +
  "configured yet - see scripts/ai/config.js.";

module.exports = { MODEL, DEFAULT_MODEL, GITHUB_MODELS_ENDPOINT, PROVIDER_PAUSED_REASON };
