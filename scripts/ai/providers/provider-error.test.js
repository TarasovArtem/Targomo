"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ProviderError } = require("./provider-error");

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
