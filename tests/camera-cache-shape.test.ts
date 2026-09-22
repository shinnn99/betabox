import { test } from "node:test";
import assert from "node:assert/strict";
import { invalidateCameraCaches } from "@/lib/camera/service";

/**
 * Cache của camera service sống trên globalThis để HMR không reset map.
 * Hệ quả: sau khi pull code thêm field mới vào CacheBucket, dev server đang
 * chạy vẫn giữ bucket shape CŨ — getCache() phải điền field thiếu chứ không
 * chỉ kiểm tra bucket có tồn tại, nếu không mọi đường đọc field mới sẽ ném
 * "Cannot read properties of undefined".
 */
const KEY = "__beta_cam_camera_service_cache__";
const g = globalThis as unknown as Record<string, unknown>;

test("bucket cũ thiếu field mới thì được điền thay vì ném TypeError", () => {
  // Đúng shape do bản code trước commit camera-MAC tạo ra.
  g[KEY] = { softLinksDoneAt: new Map(), stationMap: new Map() };

  assert.doesNotThrow(() => invalidateCameraCaches("org-1"));

  const cache = g[KEY] as Record<string, Map<string, unknown>>;
  assert.ok(cache.qrScannersCheckedAt instanceof Map);
});

test("điền field thiếu không xoá dữ liệu đã cache của field cũ", () => {
  const kept = new Map<string, number>([["org-9", 123]]);
  g[KEY] = { softLinksDoneAt: kept };

  invalidateCameraCaches("org-other");

  const cache = g[KEY] as Record<string, Map<string, unknown>>;
  assert.equal(cache.softLinksDoneAt, kept);
  assert.equal(cache.softLinksDoneAt.get("org-9"), 123);
  assert.ok(cache.stationMap instanceof Map);
});

test("bucket trống hoàn toàn cũng dựng đủ ba map", () => {
  delete g[KEY];

  invalidateCameraCaches("org-2");

  const cache = g[KEY] as Record<string, Map<string, unknown>>;
  assert.ok(cache.softLinksDoneAt instanceof Map);
  assert.ok(cache.qrScannersCheckedAt instanceof Map);
  assert.ok(cache.stationMap instanceof Map);
});
