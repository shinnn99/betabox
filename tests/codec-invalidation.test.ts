import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTION_FIELDS,
  buildCodecInvalidationPatch,
  detectConnectionChange,
} from "../src/lib/camera/codec-invalidation";

/**
 * Test HIGH-11: detect connection change + build invalidation patch.
 */

test("detectConnectionChange: chỉ đổi name → 0 field", () => {
  const changed = detectConnectionChange({});
  assert.deepEqual(changed, []);
});

test("detectConnectionChange: đổi ip → ['ip']", () => {
  const changed = detectConnectionChange({ ip: "192.168.1.10" });
  assert.deepEqual(changed, ["ip"]);
});

test("detectConnectionChange: đổi password null (clear) → ['password']", () => {
  const changed = detectConnectionChange({ password: null });
  assert.deepEqual(changed, ["password"]);
});

test("detectConnectionChange: đổi cả 5 field → tất cả", () => {
  const changed = detectConnectionChange({
    ip: "10.0.0.1",
    rtsp_port: 554,
    rtsp_path: "/stream2",
    username: "admin",
    password: "new-pass",
  });
  assert.deepEqual(new Set(changed), new Set(CONNECTION_FIELDS));
});

test("detectConnectionChange: undefined explicit KHÔNG tính là đổi", () => {
  const changed = detectConnectionChange({
    ip: undefined,
    rtsp_port: undefined,
  });
  assert.deepEqual(changed, []);
});

test("detectConnectionChange: field không phải connection KHÔNG detect", () => {
  // Giả input có thêm field name/location/status — helper phải bỏ qua.
  // Cast qua bỏ shape check để mô phỏng caller có thể truyền dư field.
  const input = {
    name: "New name",
    location: "Zone A",
    status: "active",
  } as unknown as Parameters<typeof detectConnectionChange>[0];
  const changed = detectConnectionChange(input);
  assert.deepEqual(changed, []);
});

test("buildCodecInvalidationPatch: reset đủ 4 field", () => {
  const patch = buildCodecInvalidationPatch();
  assert.deepEqual(patch, {
    codec_detected: null,
    codec_warning: null,
    codec_probed_at: null,
    codec_probe_error: null,
  });
});
