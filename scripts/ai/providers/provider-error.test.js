"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ProviderError, PROVIDER_ERROR_CODES, normalizeProviderError } = require("./provider-error");

test("ProviderError: is a real Error with name 'ProviderError'", () => {
  const err = new ProviderError("boom");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "ProviderError");
  assert.equal(err.message, "boom");
});

test("ProviderError: defaults retryable to false when not specified", () => {
  const err = new ProviderError("boom");
  assert.equal(err.retryable, false);
});

test("ProviderError: code is undefined when not specified", () => {
  const err = new ProviderError("boom");
  assert.equal(err.code, undefined);
});

test("ProviderError: carries an optional code and an explicit retryable flag", () => {
  const err = new ProviderError("rate limited", { code: 429, retryable: true });
  assert.equal(err.code, 429);
  assert.equal(err.retryable, true);
});

test("ProviderError: cause is undefined when not specified", () => {
  const err = new ProviderError("boom");
  assert.equal(err.cause, undefined);
});

test("ProviderError: carries an explicit cause, preserving the original error", () => {
  const original = new Error("ECONNRESET");
  const err = new ProviderError("AI provider request failed", { code: "NETWORK", retryable: true, cause: original });
  assert.equal(err.cause, original);
});

test("PROVIDER_ERROR_CODES: is a fixed, generic set of codes - not provider-specific strings", () => {
  assert.deepEqual(Object.keys(PROVIDER_ERROR_CODES).sort(), [
    "AUTH",
    "CONFIGURATION",
    "INVALID_RESPONSE",
    "NETWORK",
    "RATE_LIMIT",
    "TIMEOUT",
    "UNKNOWN",
  ]);
  assert.ok(Object.isFrozen(PROVIDER_ERROR_CODES));
});

test("normalizeProviderError: a ProviderError is returned unchanged, with no metadata lost", () => {
  const original = new ProviderError("rate limited", { code: PROVIDER_ERROR_CODES.RATE_LIMIT, retryable: true });
  const normalized = normalizeProviderError(original);
  assert.equal(normalized, original);
  assert.equal(normalized.code, PROVIDER_ERROR_CODES.RATE_LIMIT);
  assert.equal(normalized.retryable, true);
});

test("normalizeProviderError: an ordinary Error is wrapped as a non-retryable UNKNOWN ProviderError", () => {
  const original = new Error("something unexpected");
  const normalized = normalizeProviderError(original);

  assert.ok(normalized instanceof ProviderError);
  assert.equal(normalized.message, "something unexpected");
  assert.equal(normalized.code, PROVIDER_ERROR_CODES.UNKNOWN);
  assert.equal(normalized.retryable, false);
  assert.equal(normalized.cause, original);
});

test("normalizeProviderError: a non-Error throw (e.g. a plain object) still produces a usable ProviderError", () => {
  const normalized = normalizeProviderError({ some: "junk" });
  assert.ok(normalized instanceof ProviderError);
  assert.equal(normalized.message, "Unknown AI provider error");
  assert.equal(normalized.code, PROVIDER_ERROR_CODES.UNKNOWN);
  assert.equal(normalized.retryable, false);
});
