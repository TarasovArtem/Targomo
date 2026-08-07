"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createProvider } = require("./index");
const { MockProvider } = require("./mock-provider");
const { ProviderError } = require("./provider-error");

test("createProvider: AI_PROVIDER=mock (explicit) returns a MockProvider", () => {
  const provider = createProvider("mock");
  assert.ok(provider instanceof MockProvider);
});

test("createProvider: an unknown provider name throws a clear, exact ProviderError", () => {
  assert.throws(
    () => createProvider("foobar"),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.message, "Unsupported AI provider: foobar");
      return true;
    }
  );
});

test("createProvider: an unknown-provider error is not retryable (retrying the same bad name won't help)", () => {
  try {
    createProvider("foobar");
    assert.fail("expected createProvider to throw");
  } catch (err) {
    assert.equal(err.retryable, false);
  }
});

test("createProvider: never silently falls back to a different real provider for an unknown name", () => {
  assert.throws(() => createProvider("openai"), ProviderError);
  assert.throws(() => createProvider("groq"), ProviderError);
});

test("createProvider: called with no argument at all defaults to mock (config.js's safe default)", () => {
  const provider = createProvider();
  assert.ok(provider instanceof MockProvider);
});

test("createProvider: respects AI_PROVIDER=mock set via the environment, not just an explicit argument", (t) => {
  const saved = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "mock";
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("./index")];
  t.after(() => {
    if (saved === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./index")];
  });

  const { createProvider: createProviderFresh } = require("./index");
  assert.ok(createProviderFresh() instanceof MockProvider);
});

test("createProvider: an unset AI_PROVIDER environment variable safely defaults to mock, never a real provider", (t) => {
  const saved = process.env.AI_PROVIDER;
  delete process.env.AI_PROVIDER;
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("./index")];
  t.after(() => {
    if (saved === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./index")];
  });

  const { createProvider: createProviderFresh } = require("./index");
  assert.ok(createProviderFresh() instanceof MockProvider);
});
