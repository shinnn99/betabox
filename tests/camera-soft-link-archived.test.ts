import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Bất đối xứng archived trong `ensureCameraSoftLinks` (service.ts).
 *
 * Hàm thật chạm DB nên không gọi trực tiếp được ở đây. Thay vào đó tái dựng
 * đúng hai phép lọc mà nó dùng, và khẳng định chúng nhìn CÙNG một tập hàng —
 * đó chính là bất biến từng bị vi phạm.
 *
 * Sự cố 2026-09-16 (org Đại Kim): vòng `claimed` bỏ qua hàng `archived`, còn
 * vòng `usedCodes` thì không. Camera có soft-link đã archive bị coi là "chưa
 * claim" → rơi vào `missing`; nhưng mã `auto_dahua_3` vẫn bị coi là đã dùng →
 * sinh bản sao `auto_dahua_3_la75` thiếu `role`, không gắn được vào bàn.
 */

interface DeviceRow {
  device_code: string;
  status: string;
  config_json: { camera_id?: string } | null;
}

const CAM = "3a5112e0-3197-4d55-badb-efc37418612e";

/** Bản sao hai phép lọc của ensureCameraSoftLinks sau khi sửa. */
function planSoftLinks(devices: DeviceRow[], cameras: Array<{ id: string; camera_code: string }>) {
  const live = devices.filter((d) => d.status !== "archived");

  const claimed = new Set(
    live.map((d) => String(d.config_json?.camera_id ?? "")).filter(Boolean),
  );
  const usedCodes = new Set(live.map((d) => d.device_code));

  const missing = cameras.filter((c) => !claimed.has(c.id));
  return missing.map((c) => {
    const base = `auto_${c.camera_code}`;
    return usedCodes.has(base) ? `${base}_<random>` : base;
  });
}

test("hai phép lọc nhìn cùng tập hàng: archived không claim thì cũng không giữ mã", () => {
  const devices: DeviceRow[] = [
    { device_code: "auto_dahua_01", status: "archived", config_json: { camera_id: CAM } },
  ];

  const planned = planSoftLinks(devices, [{ id: CAM, camera_code: "dahua_01" }]);

  // Tái dùng mã của hàng archived — KHÔNG đẻ hậu tố random.
  assert.deepEqual(planned, ["auto_dahua_01"]);
});

test("hàng active giữ claim → không sinh thêm gì", () => {
  const devices: DeviceRow[] = [
    { device_code: "auto_dahua_01", status: "active", config_json: { camera_id: CAM } },
  ];
  assert.deepEqual(planSoftLinks(devices, [{ id: CAM, camera_code: "dahua_01" }]), []);
});

test("trùng mã với hàng ACTIVE khác → vẫn phải né bằng hậu tố", () => {
  const devices: DeviceRow[] = [
    // Thiết bị tay, cùng tên, không trỏ camera nào.
    { device_code: "auto_dahua_01", status: "active", config_json: null },
  ];
  assert.deepEqual(planSoftLinks(devices, [{ id: CAM, camera_code: "dahua_01" }]), [
    "auto_dahua_01_<random>",
  ]);
});

test("hình dạng sự cố cũ không tái hiện: 1 camera → nhiều nhất 1 soft-link", () => {
  const devices: DeviceRow[] = [
    { device_code: "auto_dahua_3", status: "archived", config_json: { camera_id: CAM } },
    { device_code: "qrcam_dahua_3", status: "archived", config_json: { camera_id: CAM } },
  ];
  const planned = planSoftLinks(devices, [{ id: CAM, camera_code: "dahua_3" }]);

  assert.equal(planned.length, 1);
  assert.ok(
    !planned[0].includes("<random>"),
    "mã archived phải được tái dùng, không đẻ bản sao có hậu tố",
  );
});
