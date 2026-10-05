import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Lượt dọn object mồ côi — đi TỪ BUCKET (src/lib/watch/orphan-objects.ts).
 *
 * Bối cảnh: `cleanupExpiredClips()` đi từ bảng clip nên không bao giờ thấy
 * object mà không dòng nào trỏ tới. Đo 02/10/2026: 3 object, 67 MB, nằm trên
 * bucket từ 04/07 và 16-17/09 mà không lượt dọn nào chạm tới.
 *
 * TÍNH CHẤT SỐNG CÒN được khoá ở đây: **clip ĐANG upload không được xoá.**
 * Lúc agent vừa upload xong mà chưa kịp báo về, file đã có trên bucket nhưng
 * `bucket_path` còn NULL — nhìn y hệt mồ côi. Xoá nhầm nó là biến lượt dọn
 * rác thành máy phá bằng chứng. Chốt chặn là ngưỡng tuổi 24 giờ.
 */

interface StubObj {
  name: string;
  size_bytes: number;
  created_at: string;
}

interface Removed {
  paths: string[][];
}

function fakeAdmin(objects: StubObj[], claimed: string[], removed: Removed) {
  const clipQuery: Record<string, unknown> = {
    select: () => clipQuery,
    not: () => clipQuery,
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: claimed.map((p) => ({ bucket_path: p })), error: null }),
  };
  return {
    rpc: async () => ({ data: objects, error: null }),
    from: () => clipQuery,
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removed.paths.push(paths);
          return { error: null };
        },
      }),
    },
  };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function sweep(objects: StubObj[], claimed: string[], dryRun = false) {
  const removed: Removed = { paths: [] };
  const { sweepOrphanObjects } = await import("../src/lib/watch/orphan-objects.ts");
  const result = await sweepOrphanObjects({
    client: fakeAdmin(objects, claimed, removed) as never,
    dryRun,
  });
  return { result, removed };
}

test("mồ côi đã già → xoá, và chỉ xoá đúng nó", async () => {
  const { result, removed } = await sweep(
    [
      { name: "org/live.mp4", size_bytes: 100, created_at: hoursAgo(200) },
      { name: "org/orphan.mp4", size_bytes: 67, created_at: hoursAgo(200) },
    ],
    ["org/live.mp4"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deleted, 1);
  assert.equal(result.freedBytes, 67);
  assert.deepEqual(removed.paths, [["org/orphan.mp4"]], "KHÔNG được đụng file có chủ");
});

test("SỐNG CÒN: clip vừa upload (chưa ghi bucket_path) KHÔNG bị xoá", async () => {
  const { result, removed } = await sweep(
    [{ name: "org/dang-upload.mp4", size_bytes: 500, created_at: hoursAgo(0.05) }],
    [], // chưa dòng clip nào trỏ tới — nhìn y hệt mồ côi
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deleted, 0, "file mới 3 phút tuổi TUYỆT ĐỐI không được xoá");
  assert.equal(result.tooYoung, 1);
  assert.deepEqual(removed.paths, [], "không được gọi remove lần nào");
});

test("ngay sát ngưỡng: 23 giờ tha, 25 giờ xoá", async () => {
  const { result: r23 } = await sweep(
    [{ name: "org/a.mp4", size_bytes: 1, created_at: hoursAgo(23) }],
    [],
  );
  assert.equal(r23.ok && r23.deleted, 0, "23 giờ chưa đủ tuổi");

  const { result: r25 } = await sweep(
    [{ name: "org/a.mp4", size_bytes: 1, created_at: hoursAgo(25) }],
    [],
  );
  assert.equal(r25.ok && r25.deleted, 1, "25 giờ thì xoá");
});

test("chạy khô: tính ra số nhưng KHÔNG xoá", async () => {
  const { result, removed } = await sweep(
    [{ name: "org/orphan.mp4", size_bytes: 67, created_at: hoursAgo(200) }],
    [],
    true,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deleted, 0);
  assert.equal(result.freedBytes, 67, "vẫn báo sẽ giải phóng bao nhiêu");
  assert.deepEqual(removed.paths, []);
});

test("bucket sạch → không gọi remove, không báo lỗi", async () => {
  const { result, removed } = await sweep(
    [{ name: "org/live.mp4", size_bytes: 10, created_at: hoursAgo(500) }],
    ["org/live.mp4"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deleted, 0);
  assert.equal(result.tooYoung, 0);
  assert.deepEqual(removed.paths, []);
});

test("ca thật 02/10: 3 mồ côi cũ trong 34 object → xoá đúng 3", async () => {
  const objects: StubObj[] = [
    ...Array.from({ length: 31 }, (_, i) => ({
      name: `kho/ready-${i}.mp4`,
      size_bytes: 1000,
      created_at: hoursAgo(10),
    })),
    { name: "test/cbafee3d.mp4", size_bytes: 0, created_at: hoursAgo(2100) },
    { name: "test/301ab337.mp4", size_bytes: 23846829, created_at: hoursAgo(380) },
    { name: "test/dc19f2a1.mp4", size_bytes: 46566219, created_at: hoursAgo(355) },
  ];
  const claimed = objects.slice(0, 31).map((o) => o.name);
  const { result, removed } = await sweep(objects, claimed);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deleted, 3);
  assert.equal(result.scanned, 34);
  assert.equal(result.freedBytes, 70413048, "đúng 67.2 MB");
  assert.equal(removed.paths[0].length, 3);
});
