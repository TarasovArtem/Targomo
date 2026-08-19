"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createProvider } = require("./index");
const { MockProvider } = require("./mock-provider");
const { ProviderError, PROVIDER_ERROR_CODES } = require("./provider-error");

test("createProvider: AI_PROVIDER=mock (explicit) returns a MockProvider", () => {
  const provider = createProvider("mock");
  assert.ok(provider instanceof MockProvider);
});

test("createProvider: the returned provider exposes a usable .name", () => {
  const provider = createProvider("mock");
  assert.equal(provider.name, "mock");
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
  assert.throws(() => createProvider("anthropic"), ProviderError);
});

test("createProvider: AI_PROVIDER=gemini returns a GeminiProvider when AI_API_KEY/AI_MODEL are set", (t) => {
  const savedKey = process.env.AI_API_KEY;
  const savedModel = process.env.AI_MODEL;
  process.env.AI_API_KEY = "test-key";
  process.env.AI_MODEL = "gemini-3.6-flash";
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("./gemini-provider")];
  delete require.cache[require.resolve("./index")];
  t.after(() => {
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = savedModel;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./gemini-provider")];
    delete require.cache[require.resolve("./index")];
  });

  // Duck-typing on name/constructor.name, not `instanceof` - same reasoning
  // as the groq test above: the require.cache reset means require("./index")
  // pulls in a fresh, structurally identical but distinct GeminiProvider
  // class from the one imported at the top of this file.
  const { createProvider: createProviderFresh } = require("./index");
  const provider = createProviderFresh("gemini");
  assert.equal(provider.name, "gemini");
  assert.equal(provider.constructor.name, "GeminiProvider");
});

test("createProvider: AI_PROVIDER=gemini without AI_API_KEY throws a clear CONFIGURATION error - no fallback to mock", (t) => {
  const savedKey = process.env.AI_API_KEY;
  const savedModel = process.env.AI_MODEL;
  delete process.env.AI_API_KEY;
  process.env.AI_MODEL = "gemini-3.6-flash";
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("./gemini-provider")];
  delete require.cache[require.resolve("./index")];
  t.after(() => {
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = savedModel;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./gemini-provider")];
    delete require.cache[require.resolve("./index")];
  });

  const { createProvider: createProviderFresh } = require("./index");
  assert.throws(
    () => createProviderFresh("gemini"),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test("createProvider: AI_PROVIDER=gemini without AI_MODEL throws a clear CONFIGURATION error - no fallback to mock", (t) => {
  const savedKey = process.env.AI_API_KEY;
  const savedModel = process.env.AI_MODEL;
  process.env.AI_API_KEY = "test-key";
  delete process.env.AI_MODEL;
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("./gemini-provider")];
  delete require.cache[require.resolve("./index")];
  t.after(() => {
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = savedModel;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./gemini-provider")];
    delete require.cache[require.resolve("./index")];
  });

  const { createProvider: createProviderFresh } = require("./index");
  assert.throws(
    () => createProviderFresh("gemini"),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test("createProvider: AI_PROVIDER=groq returns a GroqProvider when AI_API_KEY/AI_MODEL are set", (t) => {
  const savedKey = process.env.AI_API_KEY;
  const savedModel = process.env.AI_MODEL;
  process.env.AI_API_KEY = "test-key";
  process.env.AI_MODEL = "openai/gpt-oss-120b";
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("./groq-provider")];
  delete require.cache[require.resolve("./index")];
  t.after(() => {
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = savedModel;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./groq-provider")];
    delete require.cache[require.resolve("./index")];
  });

  // Not an `instanceof GroqProvider` check: the require.cache reset above
  // means require("./index") pulls in a fresh copy of groq-provider.js -
  // a structurally identical but distinct class from the one imported at
  // the top of this file, so instanceof would fail for reasons that have
  // nothing to do with createProvider()'s actual behavior. Duck-typing on
  // name/constructor.name instead.
  const { createProvider: createProviderFresh } = require("./index");
  const provider = createProviderFresh("groq");
  assert.equal(provider.name, "groq");
  assert.equal(provider.constructor.name, "GroqProvider");
});

test("createProvider: AI_PROVIDER=groq without AI_API_KEY throws a clear CONFIGURATION error - no fallback to mock", (t) => {
  const savedKey = process.env.AI_API_KEY;
  const savedModel = process.env.AI_MODEL;
  delete process.env.AI_API_KEY;
  process.env.AI_MODEL = "openai/gpt-oss-120b";
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("./groq-provider")];
  delete require.cache[require.resolve("./index")];
  t.after(() => {
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = savedModel;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./groq-provider")];
    delete require.cache[require.resolve("./index")];
  });

  const { createProvider: createProviderFresh } = require("./index");
  assert.throws(
    () => createProviderFresh("groq"),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test("createProvider: AI_PROVIDER=groq without AI_MODEL throws a clear CONFIGURATION error - no fallback to mock", (t) => {
  const savedKey = process.env.AI_API_KEY;
  const savedModel = process.env.AI_MODEL;
  process.env.AI_API_KEY = "test-key";
  delete process.env.AI_MODEL;
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("./groq-provider")];
  delete require.cache[require.resolve("./index")];
  t.after(() => {
    if (savedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = savedModel;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./groq-provider")];
    delete require.cache[require.resolve("./index")];
  });

  const { createProvider: createProviderFresh } = require("./index");
  assert.throws(
    () => createProviderFresh("groq"),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
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
