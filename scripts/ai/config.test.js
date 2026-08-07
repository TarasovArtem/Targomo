"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

function withEnv(name, value, fn) {
  delete require.cache[require.resolve("./config")];
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;

  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
    delete require.cache[require.resolve("./config")];
  }
}

test("config: defaults AI_PROVIDER to mock when unset", () => {
  withEnv("AI_PROVIDER", undefined, () => {
    const { PROVIDER, DEFAULT_PROVIDER } = require("./config");
    assert.equal(PROVIDER, "mock");
    assert.equal(DEFAULT_PROVIDER, "mock");
  });
});

test("config: AI_PROVIDER env var overrides the default without code changes", () => {
  withEnv("AI_PROVIDER", "some-future-provider", () => {
    const { PROVIDER } = require("./config");
    assert.equal(PROVIDER, "some-future-provider");
  });
});

test("config: AI_MODEL defaults to null when unset - meaningless to MockProvider, read by a real provider later", () => {
  withEnv("AI_MODEL", undefined, () => {
    const { MODEL, DEFAULT_MODEL } = require("./config");
    assert.equal(MODEL, null);
    assert.equal(DEFAULT_MODEL, null);
  });
});

test("config: AI_MODEL env var overrides the default without code changes", () => {
  withEnv("AI_MODEL", "some-provider/some-model", () => {
    const { MODEL } = require("./config");
    assert.equal(MODEL, "some-provider/some-model");
  });
});

test("config: AI_API_KEY defaults to null - never required for the mock provider", () => {
  withEnv("AI_API_KEY", undefined, () => {
    const { API_KEY } = require("./config");
    assert.equal(API_KEY, null);
  });
});

test("config: AI_API_KEY env var is exposed for a future real provider to read, but never logged or hardcoded here", () => {
  withEnv("AI_API_KEY", "super-secret-value", () => {
    const { API_KEY } = require("./config");
    assert.equal(API_KEY, "super-secret-value");
  });
});

test("config: no GitHub Models-specific exports remain (fully provider-neutral)", () => {
  delete require.cache[require.resolve("./config")];
  const config = require("./config");
  assert.equal("GITHUB_MODELS_ENDPOINT" in config, false);
  assert.equal("PROVIDER_PAUSED_REASON" in config, false);
});
