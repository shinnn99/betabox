import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_TTL_MS,
  PermissionGrantCache,
  buildGrants,
  grantKey,
  hasGrant,
  isCacheFresh,
  permissionsForRole,
  type PermissionCacheEntry,
} from "../src/lib/supabase/permission-cache.ts";

/**
 * Đệm ma trận quyền (06/10/2026): `checkPermission` trước đây chạy một truy
 * vấn `role_permission_matrix` cho MỖI lượt gọi API — 42.402 lượt/24h.
 *
 * Đệm ở cửa bảo vệ nên luật quan trọng nhất không phải "có nhanh không" mà
 * là "hỏng thì chặn hay mở". Các bài dưới giữ vế fail-closed.
 */

const ROWS = [
  { role: "admin", permission_code: "camera.setup" },
  { role: "admin", permission_code: "video.download" },
  { role: "viewer", permission_code: "video.download" },
];

test("tra đúng ô có trong ma trận", () => {
  const grants = buildGrants(ROWS);
  assert.equal(hasGrant(grants, "admin", "camera.setup"), true);
  assert.equal(hasGrant(grants, "viewer", "video.download"), true);
});

test("ô không có trong ma trận → false", () => {
  const grants = buildGrants(ROWS);
  assert.equal(hasGrant(grants, "viewer", "camera.setup"), false);
});

test("FAIL-CLOSED: đọc hỏng (null) → false, KHÔNG mở quyền", () => {
  // Đây là vế quan trọng nhất của cả file. Bản cũ khi truy vấn lỗi trả
  // `!!undefined` = false; đệm mới phải giữ đúng hành vi đó.
  assert.equal(hasGrant(null, "admin", "camera.setup"), false);
  assert.equal(hasGrant(null, "viewer", "video.download"), false);
});

test("ma trận rỗng khác với đọc hỏng — rỗng vẫn là câu trả lời hợp lệ", () => {
  const empty = buildGrants([]);
  assert.equal(hasGrant(empty, "admin", "camera.setup"), false);
  // và nó LÀ đệm hợp lệ, không bị coi là chưa đọc
  const entry: PermissionCacheEntry = { grants: empty, at: 1_000 };
  assert.equal(isCacheFresh(entry, 1_000), true);
});

test("đệm còn hạn thì dùng lại", () => {
  const entry: PermissionCacheEntry = { grants: buildGrants(ROWS), at: 10_000 };
  assert.equal(isCacheFresh(entry, 10_000 + PERMISSION_TTL_MS - 1), true);
});

test("đệm quá hạn thì phải đọc lại", () => {
  const entry: PermissionCacheEntry = { grants: buildGrants(ROWS), at: 10_000 };
  assert.equal(isCacheFresh(entry, 10_000 + PERMISSION_TTL_MS), false);
  assert.equal(isCacheFresh(entry, 10_000 + PERMISSION_TTL_MS + 1), false);
});

test("chưa có đệm (null) → không fresh, buộc đọc DB", () => {
  assert.equal(isCacheFresh(null, Date.now()), false);
});

test("liệt kê quyền theo vai trò, đã sắp xếp", () => {
  const grants = buildGrants(ROWS);
  assert.deepEqual(permissionsForRole(grants, "admin"), [
    "camera.setup",
    "video.download",
  ]);
  assert.deepEqual(permissionsForRole(grants, "viewer"), ["video.download"]);
  assert.deepEqual(permissionsForRole(grants, "khong_ton_tai"), []);
});

test("vai trò là tiền tố của vai trò khác không bị lẫn quyền", () => {
  // 'admin' và 'admin_kho': cắt chuỗi cẩu thả sẽ làm 'admin' nuốt quyền của
  // 'admin_kho'. Ký tự phân cách NUL trong khoá chặn điều đó.
  const grants = buildGrants([
    { role: "admin", permission_code: "a" },
    { role: "admin_kho", permission_code: "b" },
  ]);
  assert.deepEqual(permissionsForRole(grants, "admin"), ["a"]);
  assert.deepEqual(permissionsForRole(grants, "admin_kho"), ["b"]);
});

test("khoá tách role và permission KHÔNG nhập nhằng", () => {
  // Ngăn cách là ký tự NUL, không phải ':' — nếu dùng ':' thì cặp
  // ('a', 'b:c') và ('a:b', 'c') ra cùng khoá, tức cấp nhầm quyền trên một
  // cửa bảo vệ. Giữ bài này để không ai đổi về ':' cho "dễ đọc".
  assert.notEqual(grantKey("a", "b:c"), grantKey("a:b", "c"));
  assert.equal(grantKey("admin", "camera.setup").includes(":"), false);
  // Vẫn phải round-trip đúng qua permissionsForRole.
  const grants = buildGrants([{ role: "a", permission_code: "b:c" }]);
  assert.deepEqual(permissionsForRole(grants, "a"), ["b:c"]);
  assert.deepEqual(permissionsForRole(grants, "a:b"), []);
});

test("cache lạnh đồng thời chỉ gọi loader MỘT lần", async () => {
  const cache = new PermissionGrantCache();
  let loadCount = 0;
  let release!: (grants: Set<string>) => void;
  const deferred = new Promise<Set<string>>((resolve) => {
    release = resolve;
  });
  const loader = async () => {
    loadCount += 1;
    return deferred;
  };

  const first = cache.getOrLoad(loader);
  const second = cache.getOrLoad(loader);
  assert.equal(loadCount, 1, "hai request đồng thời không được đập DB hai lần");

  const grants = buildGrants(ROWS);
  release(grants);
  assert.equal(await first, grants);
  assert.equal(await second, grants);

  assert.equal(await cache.getOrLoad(loader), grants);
  assert.equal(loadCount, 1, "cache còn hạn thì không gọi loader lại");
});

test("loader trả null hoặc throw đều không được cache", async () => {
  const cache = new PermissionGrantCache();
  let loadCount = 0;

  assert.equal(
    await cache.getOrLoad(async () => {
      loadCount += 1;
      return null;
    }),
    null,
  );
  assert.equal(
    await cache.getOrLoad(async () => {
      loadCount += 1;
      throw new Error("db_down");
    }),
    null,
  );
  assert.equal(loadCount, 2, "đọc hỏng phải buộc lần sau thử DB lại");
});

test("invalidate giữa lúc load ngăn kết quả cũ ghi đè cache mới", async () => {
  let now = 1_000;
  const cache = new PermissionGrantCache(PERMISSION_TTL_MS, () => now);
  let releaseOld!: (grants: Set<string>) => void;
  const oldDeferred = new Promise<Set<string>>((resolve) => {
    releaseOld = resolve;
  });
  const oldGrants = buildGrants([
    { role: "admin", permission_code: "old.permission" },
  ]);
  const newGrants = buildGrants([
    { role: "admin", permission_code: "new.permission" },
  ]);

  const oldRequest = cache.getOrLoad(async () => oldDeferred);
  cache.invalidate();
  now += 1;

  const newRequest = cache.getOrLoad(async () => newGrants);
  assert.equal(await newRequest, newGrants);

  // Lượt đọc cũ về SAU invalidate và sau cả lượt mới. Nó được trả cho request
  // cũ, nhưng tuyệt đối không được chép oldGrants trở lại cache.
  releaseOld(oldGrants);
  assert.equal(await oldRequest, oldGrants);

  let unexpectedReload = 0;
  const cached = await cache.getOrLoad(async () => {
    unexpectedReload += 1;
    return oldGrants;
  });
  assert.equal(cached, newGrants);
  assert.equal(unexpectedReload, 0);
});

test("invalidate buộc request kế tiếp đọc lại ngay", async () => {
  const cache = new PermissionGrantCache();
  let loadCount = 0;
  const first = buildGrants([{ role: "admin", permission_code: "a" }]);
  const second = buildGrants([{ role: "admin", permission_code: "b" }]);

  assert.equal(
    await cache.getOrLoad(async () => {
      loadCount += 1;
      return first;
    }),
    first,
  );
  cache.invalidate();
  assert.equal(
    await cache.getOrLoad(async () => {
      loadCount += 1;
      return second;
    }),
    second,
  );
  assert.equal(loadCount, 2);
});
