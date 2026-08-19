"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { GeminiProvider } = require("./gemini-provider");
const { ProviderError, PROVIDER_ERROR_CODES } = require("./provider-error");

// Fakes global fetch's Response shape just enough for GeminiProvider - no
// real network access anywhere in this file.
function fakeResponse({ ok = true, status = 200, body }) {
  return { ok, status, json: async () => body };
}

function generateContentBody(text) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function provider(overrides = {}) {
  return new GeminiProvider({
    apiKey: "test-key",
    model: "gemini-3.6-flash",
    fetchImpl: async () => fakeResponse({ body: generateContentBody('{"results":[]}') }),
    ...overrides,
  });
}

test("GeminiProvider: name is 'gemini'", () => {
  assert.equal(provider().name, "gemini");
});

// --- success -----------------------------------------------------------

test("GeminiProvider.analyze: returns the model content as a string", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: generateContentBody('{"results":[]}') }) });
  const result = await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
  assert.equal(result, '{"results":[]}');
  assert.equal(typeof result, "string");
});

test("GeminiProvider.analyze: sends the configured model in the URL, the expected headers, and both prompts mapped correctly", async () => {
  let capturedUrl;
  let capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return fakeResponse({ body: generateContentBody("ok") });
  };
  const p = new GeminiProvider({ apiKey: "my-key", model: "gemini-3.6-flash", fetchImpl });

  await p.analyze({ systemPrompt: "SYSTEM", userPrompt: "USER" });

  assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers["x-goog-api-key"], "my-key");
  assert.equal(capturedInit.headers["Content-Type"], "application/json");

  const body = JSON.parse(capturedInit.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "SYSTEM" }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "USER" }] }]);
});

test("GeminiProvider.analyze: a different configured model changes the URL - the model is never hardcoded", async () => {
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return fakeResponse({ body: generateContentBody("ok") });
  };
  const p = new GeminiProvider({ apiKey: "key", model: "gemini-2.5-pro", fetchImpl });
  await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
  assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
});

test("GeminiProvider.analyze: concatenates multiple text parts deterministically, in order", async () => {
  const p = provider({
    fetchImpl: async () =>
      fakeResponse({
        body: { candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }] },
      }),
  });
  const result = await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
  assert.equal(result, "hello world");
});

test("GeminiProvider.analyze: a non-text part (e.g. a future function-call-shaped part) is skipped, not coerced to a string", async () => {
  const p = provider({
    fetchImpl: async () =>
      fakeResponse({
        body: { candidates: [{ content: { parts: [{ functionCall: { name: "x" } }, { text: "the actual text" }] } }] },
      }),
  });
  const result = await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
  assert.equal(result, "the actual text");
});

// --- configuration -------------------------------------------------------

test("GeminiProvider: missing API key throws CONFIGURATION, non-retryable", () => {
  assert.throws(
    () => new GeminiProvider({ apiKey: null, model: "gemini-3.6-flash", fetchImpl: async () => {} }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test("GeminiProvider: missing model throws CONFIGURATION, non-retryable", () => {
  assert.throws(
    () => new GeminiProvider({ apiKey: "key", model: null, fetchImpl: async () => {} }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

// --- HTTP error mapping ----------------------------------------------------

async function analyzeExpectingError(status) {
  const p = provider({ fetchImpl: async () => fakeResponse({ ok: false, status }) });
  try {
    await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
    assert.fail(`expected HTTP ${status} to throw`);
  } catch (err) {
    return err;
  }
}

test("GeminiProvider: HTTP 401 maps to AUTH, non-retryable", async () => {
  const err = await analyzeExpectingError(401);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.code, PROVIDER_ERROR_CODES.AUTH);
  assert.equal(err.retryable, false);
});

test("GeminiProvider: HTTP 403 maps to AUTH, non-retryable", async () => {
  const err = await analyzeExpectingError(403);
  assert.equal(err.code, PROVIDER_ERROR_CODES.AUTH);
  assert.equal(err.retryable, false);
});

test("GeminiProvider: HTTP 429 maps to RATE_LIMIT, retryable", async () => {
  const err = await analyzeExpectingError(429);
  assert.equal(err.code, PROVIDER_ERROR_CODES.RATE_LIMIT);
  assert.equal(err.retryable, true);
});

test("GeminiProvider: HTTP 500 is UNKNOWN, retryable", async () => {
  const err = await analyzeExpectingError(500);
  assert.equal(err.code, PROVIDER_ERROR_CODES.UNKNOWN);
  assert.equal(err.retryable, true);
});

test("GeminiProvider: HTTP 503 is UNKNOWN, retryable", async () => {
  const err = await analyzeExpectingError(503);
  assert.equal(err.code, PROVIDER_ERROR_CODES.UNKNOWN);
  assert.equal(err.retryable, true);
});

test("GeminiProvider: HTTP 504 is UNKNOWN, retryable (Gemini documents this as a 5xx gateway timeout, not a 408)", async () => {
  const err = await analyzeExpectingError(504);
  assert.equal(err.code, PROVIDER_ERROR_CODES.UNKNOWN);
  assert.equal(err.retryable, true);
});

test("GeminiProvider: an unmapped 4xx (e.g. 400 or 404) is UNKNOWN, not retryable", async () => {
  const err400 = await analyzeExpectingError(400);
  assert.equal(err400.code, PROVIDER_ERROR_CODES.UNKNOWN);
  assert.equal(err400.retryable, false);
  const err404 = await analyzeExpectingError(404);
  assert.equal(err404.retryable, false);
});

// --- network / timeout ------------------------------------------------------

test("GeminiProvider: a network-level fetch failure maps to NETWORK, retryable, with cause preserved", async () => {
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

test("GeminiProvider: an AbortController timeout maps to TIMEOUT, retryable - deterministic, no real waiting", async () => {
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

test("GeminiProvider.analyze: the fetch call receives an AbortSignal", async () => {
  let capturedInit;
  const fetchImpl = async (url, init) => {
    capturedInit = init;
    return fakeResponse({ body: generateContentBody("ok") });
  };
  const p = provider({ fetchImpl });
  await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
  assert.ok(capturedInit.signal instanceof AbortSignal);
});

// --- malformed / missing response content -----------------------------------

test("GeminiProvider: HTTP 200 with an unparseable JSON body throws INVALID_RESPONSE, non-retryable", async () => {
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

test("GeminiProvider: missing candidates array throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: {} }) });
  await assert.rejects(() => p.analyze({ systemPrompt: "sys", userPrompt: "user" }), (err) => {
    assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
    assert.equal(err.retryable, false);
    return true;
  });
});

test("GeminiProvider: an empty candidates array throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: { candidates: [] } }) });
  await assert.rejects(() => p.analyze({ systemPrompt: "sys", userPrompt: "user" }), (err) => {
    assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
    return true;
  });
});

test("GeminiProvider: a candidate with missing content throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: { candidates: [{ finishReason: "SAFETY" }] } }) });
  await assert.rejects(() => p.analyze({ systemPrompt: "sys", userPrompt: "user" }), (err) => {
    assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
    return true;
  });
});

test("GeminiProvider: a candidate with empty parts throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: { candidates: [{ content: { parts: [] } }] } }) });
  await assert.rejects(() => p.analyze({ systemPrompt: "sys", userPrompt: "user" }), (err) => {
    assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
    return true;
  });
});

test("GeminiProvider: a candidate whose parts contain no usable text (non-text parts only) throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({
    fetchImpl: async () => fakeResponse({ body: { candidates: [{ content: { parts: [{ functionCall: { name: "x" } }] } } ] } }),
  });
  await assert.rejects(() => p.analyze({ systemPrompt: "sys", userPrompt: "user" }), (err) => {
    assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
    return true;
  });
});

test("GeminiProvider: a candidate with an empty-string text part throws INVALID_RESPONSE, non-retryable", async () => {
  const p = provider({ fetchImpl: async () => fakeResponse({ body: generateContentBody("") }) });
  await assert.rejects(() => p.analyze({ systemPrompt: "sys", userPrompt: "user" }), (err) => {
    assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
    return true;
  });
});

// --- one-call invariant ------------------------------------------------------

test("GeminiProvider.analyze: exactly one fetchImpl call per analyze() call - no internal retry on a retryable-shaped failure", async () => {
  let calls = 0;
  const p = provider({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse({ ok: false, status: 429 });
    },
  });
  await assert.rejects(() => p.analyze({ systemPrompt: "sys", userPrompt: "user" }));
  assert.equal(calls, 1, "GeminiProvider must never retry internally - core owns all retry logic");
});

test("GeminiProvider.analyze: exactly one fetchImpl call on success", async () => {
  let calls = 0;
  const p = provider({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse({ body: generateContentBody("ok") });
    },
  });
  await p.analyze({ systemPrompt: "sys", userPrompt: "user" });
  assert.equal(calls, 1);
});
