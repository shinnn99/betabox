import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCameraAuditDiff } from "../src/lib/camera/service.ts";

/**
 * Audit `camera.update` phải kể ĐỔI TỪ GÌ SANG GÌ, không chỉ ĐỔI TRƯỜNG NÀO.
 *
 * Sự cố 2026-09-16: camera kho Đại Kim bị ghi đè 8 trường. Audit cũ chỉ lưu
 * `fields: ["ip", ...]` nên `ip` gốc không còn tồn tại ở đâu trong hệ thống —
 * phải ra tận kho đọc lại từ thiết bị.
 */

const BEFORE = {
  name: "Dahua 01",
  camera_code: "dahua_01",
  ip: "192.168.1.236",
  rtsp_port: 554,
  username: "admin",
  rtsp_path: "/cam/realmonitor?channel=1&subtype=0",
  rtsp_substream_path: "/cam/realmonitor?channel=1&subtype=1",
  location: null,
  status: "active",
};

test("ghi lại from/to của đúng trường đã đổi", () => {
  const diff = buildCameraAuditDiff(BEFORE, {
    ...BEFORE,
    camera_code: "dahua_3",
    ip: "192.168.31.12",
  });

  assert.deepEqual(diff, {
    camera_code: { from: "dahua_01", to: "dahua_3" },
    ip: { from: "192.168.1.236", to: "192.168.31.12" },
  });
});

test("trường không đổi thì không xuất hiện", () => {
  const diff = buildCameraAuditDiff(BEFORE, { ...BEFORE, name: "Dahua 02" });
  assert.deepEqual(Object.keys(diff), ["name"]);
});

test("không đổi gì → diff rỗng", () => {
  assert.deepEqual(buildCameraAuditDiff(BEFORE, { ...BEFORE }), {});
});

test("KHÔNG BAO GIỜ lộ mật khẩu vào audit", () => {
  const diff = buildCameraAuditDiff(
    { ...BEFORE, password_ciphertext: "OLD", password_iv: "IV1", password_tag: "T1" },
    { ...BEFORE, password_ciphertext: "NEW", password_iv: "IV2", password_tag: "T2" },
  );

  const serialized = JSON.stringify(diff);
  for (const secret of ["OLD", "NEW", "IV1", "IV2", "T1", "T2"]) {
    assert.ok(!serialized.includes(secret), `rò rỉ ${secret} vào audit`);
  }
  assert.deepEqual(diff, {});
});

test("null ↔ giá trị được ghi nhận hai chiều", () => {
  assert.deepEqual(
    buildCameraAuditDiff(BEFORE, { ...BEFORE, location: "Bàn 01" }),
    { location: { from: null, to: "Bàn 01" } },
  );
  assert.deepEqual(
    buildCameraAuditDiff({ ...BEFORE, location: "Bàn 01" }, BEFORE),
    { location: { from: "Bàn 01", to: null } },
  );
});

test("thiếu before hoặc after → diff rỗng, không ném lỗi", () => {
  assert.deepEqual(buildCameraAuditDiff(null, BEFORE), {});
  assert.deepEqual(buildCameraAuditDiff(BEFORE, null), {});
  assert.deepEqual(buildCameraAuditDiff(undefined, undefined), {});
});

test("khôi phục được: diff đủ để dựng lại giá trị cũ", () => {
  const after = { ...BEFORE, camera_code: "dahua_3", ip: "192.168.31.12" };
  const diff = buildCameraAuditDiff(BEFORE, after);

  const restored: Record<string, unknown> = { ...after };
  for (const [field, { from }] of Object.entries(diff)) restored[field] = from;

  assert.deepEqual(restored, BEFORE);
});
