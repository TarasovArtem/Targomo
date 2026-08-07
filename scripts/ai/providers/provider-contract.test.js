"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateProvider, validateProviderResponse } = require("./provider-contract");
const { ProviderError, PROVIDER_ERROR_CODES } = require("./provider-error");

test("validateProvider: accepts an object with an analyze() function", () => {
  assert.doesNotThrow(() => validateProvider({ analyze: async () => "ok" }));
});

test("validateProvider: rejects an object missing analyze() with a clear, exact message", () => {
  assert.throws(
    () => validateProvider({}),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.message, "Invalid AI provider: analyze() function is required");
      assert.equal(err.code, PROVIDER_ERROR_CODES.CONFIGURATION);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test("validateProvider: rejects a provider whose analyze is not a function", () => {
  assert.throws(() => validateProvider({ analyze: "not-a-function" }), ProviderError);
});

test("validateProvider: rejects null/undefined outright", () => {
  assert.throws(() => validateProvider(null), ProviderError);
  assert.throws(() => validateProvider(undefined), ProviderError);
});

test("validateProviderResponse: accepts a non-empty string", () => {
  assert.doesNotThrow(() => validateProviderResponse('{"results":[]}'));
});

test("validateProviderResponse: rejects an empty string", () => {
  assert.throws(
    () => validateProviderResponse(""),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /empty response/i);
      assert.equal(err.code, PROVIDER_ERROR_CODES.INVALID_RESPONSE);
      return true;
    }
  );
});

test("validateProviderResponse: rejects a whitespace-only string", () => {
  assert.throws(() => validateProviderResponse("   \n\t  "), /empty response/i);
});

test("validateProviderResponse: rejects null", () => {
  assert.throws(() => validateProviderResponse(null), /invalid response type/i);
});

test("validateProviderResponse: rejects undefined", () => {
  assert.throws(() => validateProviderResponse(undefined), /invalid response type/i);
});

test("validateProviderResponse: rejects a plain object (not yet parsed/stringified)", () => {
  assert.throws(() => validateProviderResponse({ results: [] }), /invalid response type/i);
});

test("validateProviderResponse: rejects an array", () => {
  assert.throws(() => validateProviderResponse([]), /invalid response type/i);
});
