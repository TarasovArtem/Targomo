/**
 * Single source of truth for AI provider configuration.
 *
 * The QA Agent talks to GitHub Models (https://docs.github.com/en/github-models),
 * authenticated with the same GITHUB_TOKEN every GitHub Actions run already
 * has - no separate API key, account, or billing setup required. Every
 * other scripts/ai/*.js file imports MODEL/ENDPOINT from here rather than
 * hardcoding either, so changing providers or models is a one-line change
 * in one file.
 */

"use strict";

// Overridable via the AI_MODEL environment variable (e.g. in the workflow:
// `env: AI_MODEL: openai/gpt-4o-mini`) without touching source code.
// openai/gpt-4o is GitHub Models' catalog id for OpenAI's GPT-4o - see
// https://github.com/marketplace/models for the full catalog of available
// "<publisher>/<model>" ids.
const DEFAULT_MODEL = "openai/gpt-4o";
const MODEL = process.env.AI_MODEL || DEFAULT_MODEL;

// Official GitHub Models inference endpoint - OpenAI-Chat-Completions-
// compatible, authenticated with `Authorization: Bearer <GITHUB_TOKEN>`.
const GITHUB_MODELS_ENDPOINT = "https://models.github.ai/inference/chat/completions";

module.exports = { MODEL, DEFAULT_MODEL, GITHUB_MODELS_ENDPOINT };
