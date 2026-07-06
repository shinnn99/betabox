import { test } from "node:test";
import assert from "node:assert/strict";
import { secureCompare, verifyBearerSecret } from "../src/lib/secure-compare";

/**
 * Test HIGH-14: timing-safe secret compare + Bearer verify.
 */

test("secureCompare: match cùng string → true", () => {
  assert.equal(secureCompare("hello-secret", "hello-secret"), true);
});

test("secureCompare: khác byte đầu → false", () => {
  assert.equal(secureCompare("Xello-secret", "hello-secret"), false);
});

test("secureCompare: khác byte cuối → false", () => {
  assert.equal(secureCompare("hello-secreX", "hello-secret"), false);
});

test("secureCompare: khác length → false, không throw", () => {
  assert.equal(secureCompare("hello", "hello-world"), false);
  assert.equal(secureCompare("hello-world", "hello"), false);
});

test("secureCompare: null / undefined / empty → false", () => {
  assert.equal(secureCompare(null, "secret"), false);
  assert.equal(secureCompare("secret", null), false);
  assert.equal(secureCompare(undefined, "secret"), false);
  assert.equal(secureCompare("", "secret"), false);
  assert.equal(secureCompare("secret", ""), false);
  assert.equal(secureCompare("", ""), false);
});

test("secureCompare: unicode (multi-byte) match đúng", () => {
  assert.equal(secureCompare("mật-khẩu", "mật-khẩu"), true);
});

test("verifyBearerSecret: 'Bearer <secret>' đúng → true", () => {
  assert.equal(verifyBearerSecret("Bearer abc123", "abc123"), true);
});

test("verifyBearerSecret: không có prefix 'Bearer ' → false", () => {
  assert.equal(verifyBearerSecret("abc123", "abc123"), false);
  assert.equal(verifyBearerSecret("Basic abc123", "abc123"), false);
});

test("verifyBearerSecret: secret không match → false", () => {
  assert.equal(verifyBearerSecret("Bearer wrong", "expected"), false);
});

test("verifyBearerSecret: null / undefined → false", () => {
  assert.equal(verifyBearerSecret(null, "secret"), false);
  assert.equal(verifyBearerSecret("Bearer x", null), false);
});

/**
 * Timing test: không đo thời gian chính xác (Node event loop noise cao),
 * chỉ kiểm rằng KHÔNG throw khi length khác — điều kiện cần để không lộ
 * timing qua exception khác nhau.
 */
test("secureCompare: không throw dù length lệch nhiều", () => {
  assert.doesNotThrow(() => secureCompare("a", "a".repeat(1000)));
  assert.doesNotThrow(() => secureCompare("a".repeat(1000), "a"));
});
