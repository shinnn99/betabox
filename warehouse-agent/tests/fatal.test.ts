import { test } from "node:test";
import assert from "node:assert/strict";
import { installFatalHandlers, swallow } from "../src/fatal";

/**
 * Test CRIT-3: fatal handlers cho agent 24/7.
 *
 * Chạy: pnpm exec tsx --test tests/fatal.test.ts
 */

test("installFatalHandlers is idempotent", () => {
  const before = process.listenerCount("unhandledRejection");
  installFatalHandlers();
  installFatalHandlers();
  installFatalHandlers();
  const after = process.listenerCount("unhandledRejection");
  assert.equal(after - before, 1, "chỉ install 1 listener bất kể gọi bao nhiêu lần");
});

test("swallow catches rejected promise and logs tag", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => {
    logs.push(String(msg));
  };
  try {
    swallow(Promise.reject(new Error("boom")), "test-tag");
    // Đợi microtask flush
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = orig;
  }
  const joined = logs.join("\n");
  assert.match(joined, /\[swallow:test-tag\]/, "log phải chứa tag");
  assert.match(joined, /boom/, "log phải chứa message của err");
});

test("swallow does NOT leak to unhandledRejection", async () => {
  installFatalHandlers();
  let leaked = false;
  const listener = () => {
    leaked = true;
  };
  process.on("unhandledRejection", listener);
  try {
    const orig = console.error;
    console.error = () => {};
    try {
      swallow(Promise.reject(new Error("silent")), "no-leak");
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      console.error = orig;
    }
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.equal(leaked, false, "swallow bắt lỗi, unhandledRejection không kích hoạt");
});

test("swallow handles non-Error rejection value", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => {
    logs.push(String(msg));
  };
  try {
    swallow(Promise.reject("plain-string-reason"), "string-reject");
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = orig;
  }
  const joined = logs.join("\n");
  assert.match(joined, /\[swallow:string-reject\]/);
  assert.match(joined, /plain-string-reason/);
});
