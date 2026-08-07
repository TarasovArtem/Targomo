"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { GroqProvider } = require("./groq-provider");
const { ProviderError, PROVIDER_ERROR_CODES } = require("./provider-error");

// Fakes global fetch's Response shape just enough for GroqProvider - no
// real network access anywhere in this file.
function fakeResponse({ ok = true, status = 200, body }) {
  return { ok, status, json: async () => body };
}

function chatCompletionBody(content) {
  return { choices: [{ message: { content } }] };
}

function provider(overrides = {}) {
  return new GroqProvider({
    apiKey: "test-key",
    model: "openai/gpt-oss-120b",
    fetchImpl: async () => fakeResponse({ body: chatCompletionBody('{"results":[]}') }),
    ...overrides,
  });
}

test("GroqProvider: name is 'groq'", () => {
  assert.equal(provider().name, "groq");
});

// --- success ---------------------------------------------------------------

test("GroqProvider.analyze: returns the model content as a string", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: chatCompletionBody('{"results":[]}') }) });
  const result = await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
  assert.equal(result, '{"results":[]}');
});

test("GroqProvider.analyze: sends the configured model, both prompts, and the expected headers", async () => {
  let capturedUrl;
  let capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return fakeResponse({ body: chatCompletionBody("ok") });
  };
  const p = new GroqProvider({ apiKey: "my-key", model: "openai/gpt-oss-120b", fetchImpl });

  await p.analyze({ systemPrompt: "SYSTEM", userPrompt: "USER" });

  assert.equal(capturedUrl, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers.Authorization, "Bearer my-key");
  assert.equal(capturedInit.headers["Content-Type"], "application/json");

  const body = JSON.parse(capturedInit.body);
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.deepEqual(body.messages, [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "USER" },
  ]);
});

// --- configuration -----------------------------------------------------

test("GroqProvider: missing API key throws CONFIGURATION, non-retryable", () => {
  assert.throws(
    () => new GroqProvider({ apiKey: null, model: "openai/gpt-oss-120b", fetchImpl: async () => {} }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test("GroqProvider: missing model throws CONFIGURATION, non-retryable", () => {
  assert.throws(
    () => new GroqProvider({ apiKey: "key", model: null, fetchImpl: async () => {} }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

// --- HTTP error mapping ------------------------------------------------

async function analyzeExpectingError(status) {
  const p = provider({ fetchImpl: async () => fakeResponse({ ok: false, status }) });
  try {
    await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
    assert.fail(`expected HTTP ${status} to throw`);
  } catch (err) {
    return err;
  }
}

test("GroqProvider: HTTP 401 maps to AUTH, non-retryable", async () => {
  const err = await analyzeExpectingError(401);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.code, PROVIDER_ERROR_CODES.AUTH);
  assert.equal(err.retryable, false);
});

test("GroqProvider: HTTP 403 maps to AUTH, non-retryable", async () => {
  const err = await analyzeExpectingError(403);
  assert.equal(err.code, PROVIDER_ERROR_CODES.AUTH);
  assert.equal(err.retryable, false);
});

test("GroqProvider: HTTP 429 maps to RATE_LIMIT, retryable", async () => {
  const err = await analyzeExpectingError(429);
  assert.equal(err.code, PROVIDER_ERROR_CODES.RATE_LIMIT);
  assert.equal(err.retryable, true);
});

test("GroqProvider: HTTP 408 maps to TIMEOUT, retryable", async () => {
  const err = await analyzeExpectingError(408);
  assert.equal(err.code, PROVIDER_ERROR_CODES.TIMEOUT);
  assert.equal(err.retryable, true);
});

test("GroqProvider: HTTP 500 is retryable", async () => {
  const err = await analyzeExpectingError(500);
  assert.equal(err.retryable, true);
});

test("GroqProvider: HTTP 503 is retryable", async () => {
  const err = await analyzeExpectingError(503);
  assert.equal(err.retryable, true);
});

test("GroqProvider: an unmapped 4xx (e.g. 400) is not retryable", async () => {
  const err = await analyzeExpectingError(400);
  assert.equal(err.retryable, false);
});

// --- network / timeout --------------------------------------------------

test("GroqProvider: a network-level fetch failure maps to NETWORK, retryable, with cause preserved", async () => {
  const networkError = new Error("network down");
  const p = provider({
    fetchImpl: async () => {
      throw networkError;
    },
  });

  await assert.rejects(
    () => p.analyze({ systemPrompt: "sys", userPrompt: "user" }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.NETWORK);
      assert.equal(err.retryable, true);
      assert.equal(err.cause, networkError);
      return true;
    }
  );
});

test("GroqProvider: an AbortController timeout maps to TIMEOUT, retryable - deterministic, no real waiting", async () => {
  // fetchImpl honors the AbortSignal exactly like a real fetch would,
  // rejecting with a DOMException-shaped AbortError as soon as the
  // provider's own short timeoutMs fires - no real 30s wait in this test.
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const abortErr = new Error("The operation was aborted");
        abortErr.name = "AbortError";
        reject(abortErr);
      });
    });

  const p = provider({ fetchImpl, timeoutMs: 10 });

  await assert.rejects(
    () => p.analyze({ systemPrompt: "sys", userPrompt: "user" }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.TIMEOUT);
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

// --- malformed response ---------------------------------------------------

test("GroqProvider: HTTP 200 with no message content throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: { choices: [] } }) });
  await assert.rejects(
    () => p.analyze({ systemPrompt: "sys", userPrompt: "user" }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test("GroqProvider: HTTP 200 with an empty content string throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: chatCompletionBody("") }) });
  await assert.rejects(() => p.analyze({ systemPrompt: "sys", userPrompt: "user" }), (err) => {
    assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
    return true;
  });
});

test("GroqProvider: HTTP 200 with an unparseable JSON body throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token");
      },
    }),
  });
  await assert.rejects(
    () => p.analyze({ systemPrompt: "sys", userPrompt: "user" }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});
