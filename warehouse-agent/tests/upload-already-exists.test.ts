import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  attemptTimeoutMs,
  isAlreadyExistsResponse,
  uploadWithTimeout,
} from "../src/upload";

/**
 * Chạy thử đầu-cuối 21/09/2026, uplink ~180 KB/s: clip 34 MB hết giờ chờ
 * (~117 s) trong khi file vẫn đang lên và lên xong. Lần thử lại bị Supabase
 * từ chối "The resource already exists" → clip kẹt 'failed' dù đã nằm trên
 * bucket. Các test dưới khoá ba chỗ sửa.
 */

const DUP_BODY = '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}';

test("nhận ra phản hồi object đã tồn tại của Supabase", () => {
  assert.equal(isAlreadyExistsResponse(400, DUP_BODY), true);
  assert.equal(isAlreadyExistsResponse(409, "The resource already exists"), true);
  assert.equal(isAlreadyExistsResponse(400, '{"error":"InvalidJWT"}'), false);
  assert.equal(isAlreadyExistsResponse(403, DUP_BODY), false);
});

test("thời gian chờ gấp đôi sau mỗi lần thử, kẹp ở max", () => {
  const size = 34 * 1024 * 1024; // 20s + 34×3s = 122s
  assert.equal(attemptTimeoutMs(size, 1), 122_000);
  assert.equal(attemptTimeoutMs(size, 2), 244_000);
  assert.equal(attemptTimeoutMs(size, 3), 300_000);
  // file nhỏ: 30s → 60s → 120s
  assert.equal(attemptTimeoutMs(1024, 1), 30_000);
  assert.equal(attemptTimeoutMs(1024, 3), 120_000);
});

test("PUT gặp object đã tồn tại → trả already_exists, không thử lại", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(DUP_BODY, { status: 400 });
  }) as typeof fetch;
  try {
    const r = await uploadWithTimeout("https://x.invalid/u", Buffer.from("abc"), {
      initialBackoffMs: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "already_exists");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("clip-cutter đi tiếp báo upload-complete khi object đã tồn tại; lệnh trùng id bị bỏ qua", () => {
  const src = readFileSync("src/index.ts", "utf8");
  assert.ok(src.includes('uploadResult.errorKind === "already_exists"'));
  assert.ok(src.includes("inFlightCommandIds.has(cmd.id)"));
  assert.ok(src.includes("inFlightCommandIds.delete(cmd.id)"), "phải gỡ id trong finally");
});
