"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

test("config: defaults AI_MODEL to openai/gpt-4o when unset", (t) => {
  delete require.cache[require.resolve("./config")];
  const saved = process.env.AI_MODEL;
  delete process.env.AI_MODEL;
  t.after(() => {
    if (saved === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = saved;
    delete require.cache[require.resolve("./config")];
  });

  const { MODEL, DEFAULT_MODEL } = require("./config");
  assert.equal(MODEL, "openai/gpt-4o");
  assert.equal(DEFAULT_MODEL, "openai/gpt-4o");
});

test("config: AI_MODEL env var overrides the default without code changes", (t) => {
  delete require.cache[require.resolve("./config")];
  const saved = process.env.AI_MODEL;
  process.env.AI_MODEL = "openai/gpt-4o-mini";
  t.after(() => {
    if (saved === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = saved;
    delete require.cache[require.resolve("./config")];
  });

  const { MODEL } = require("./config");
  assert.equal(MODEL, "openai/gpt-4o-mini");
});

test("config: points at the official GitHub Models inference endpoint", () => {
  delete require.cache[require.resolve("./config")];
  const { GITHUB_MODELS_ENDPOINT } = require("./config");
  assert.equal(GITHUB_MODELS_ENDPOINT, "https://models.github.ai/inference/chat/completions");
});
