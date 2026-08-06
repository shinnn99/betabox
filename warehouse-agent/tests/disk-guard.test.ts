import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DiskGuard,
  RepeatNotifier,
  classifyLevel,
  computeBytesPerRecordingHour,
  computeRecordingHoursRemaining,
  orderSegmentCandidates,
  parseDayDirMs,
  readVolumeUsage,
  type SegmentCandidate,
} from "../src/disk-guard";

/**
 * Disk guard tests.
 *
 * Verify HAI NỬA cho phần xoá (chốt trong QUY_UOC_KY_THUAT):
 *   - nửa dương-đúng: segment cũ hơn sàn → BỊ xoá.
 *   - nửa âm-đúng: segment trong sàn, `_clips`, và ca đang cắt clip →
 *     KHÔNG bị đụng.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;

async function makeRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "disk-guard-test-"));
}

/** Tạo `<root>/<cam>/YYYY/MM/DD/<name>.mp4` theo mốc UTC. */
async function makeSegment(
  root: string,
  cameraCode: string,
  atMs: number,
  name: string,
  bytes = 1024,
): Promise<string> {
  const d = new Date(atMs);
  const dir = path.join(
    root,
    cameraCode,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
  await mkdir(dir, { recursive: true });
  const abs = path.join(dir, name);
  await writeFile(abs, Buffer.alloc(bytes));
  return abs;
}

// ============================================================================
// Hàm thuần
// ============================================================================

test("computeBytesPerRecordingHour: 60 file × 10MB, segment 60s → 600MB/giờ ghi", () => {
  const files = Array.from({ length: 60 }, () => ({ sizeBytes: 10 * 1024 ** 2 }));
  const rate = computeBytesPerRecordingHour(files, 60);
  // 60 file × 60s = 3600s = 1 giờ ghi → tổng 600MB
  assert.equal(rate, 600 * 1024 ** 2);
});

test("computeBytesPerRecordingHour: không có file / segmentSeconds<=0 → null", () => {
  assert.equal(computeBytesPerRecordingHour([], 60), null);
  assert.equal(computeBytesPerRecordingHour([{ sizeBytes: 100 }], 0), null);
  assert.equal(computeBytesPerRecordingHour([{ sizeBytes: 0 }], 60), null);
});

test("computeRecordingHoursRemaining: rate null → null (không đoán)", () => {
  assert.equal(computeRecordingHoursRemaining(100 * GIB, null), null);
  assert.equal(computeRecordingHoursRemaining(100 * GIB, 0), null);
  assert.equal(computeRecordingHoursRemaining(10 * GIB, 1 * GIB), 10);
});

test("classifyLevel: theo GIỜ GHI, không theo phần trăm ổ", () => {
  const opts = { warnHours: 48, actionHours: 12, absoluteFloorBytes: 5 * GIB };
  // Ổ to nhưng tốc độ cao → vẫn action. Ổ nhỏ nhưng tốc độ thấp → ok.
  assert.equal(classifyLevel(400 * GIB, 10, opts), "action");
  assert.equal(classifyLevel(50 * GIB, 200, opts), "ok");
  assert.equal(classifyLevel(100 * GIB, 30, opts), "warn");
});

test("classifyLevel: dưới sàn tuyệt đối → action KỂ CẢ khi chưa đo được tốc độ", () => {
  const opts = { warnHours: 48, actionHours: 12, absoluteFloorBytes: 5 * GIB };
  assert.equal(classifyLevel(1 * GIB, null, opts), "action");
  // Chưa đo được tốc độ + còn nhiều chỗ → ok (không đoán bừa).
  assert.equal(classifyLevel(100 * GIB, null, opts), "ok");
});

test("parseDayDirMs: chỉ nhận YYYY/MM/DD hợp lệ", () => {
  assert.equal(parseDayDirMs("2026", "08", "06"), Date.parse("2026-08-06T00:00:00.000Z"));
  assert.equal(parseDayDirMs("2026", "8", "06"), null);
  assert.equal(parseDayDirMs("abcd", "08", "06"), null);
  assert.equal(parseDayDirMs("2026", "13", "40"), null);
});

test("orderSegmentCandidates: loại file trong sàn, xếp cũ nhất trước", () => {
  const now = Date.parse("2026-08-06T12:00:00.000Z");
  const mk = (dayIso: string, p: string): SegmentCandidate => ({
    absPath: p,
    dayMs: Date.parse(`${dayIso}T00:00:00.000Z`),
    cameraCode: "CAM1",
  });
  const out = orderSegmentCandidates(
    [
      mk("2026-08-05", "moi.mp4"), // 1 ngày trước — trong sàn
      mk("2026-07-01", "cu-nhat.mp4"), // 36 ngày — ứng viên
      mk("2026-07-20", "cu.mp4"), // 17 ngày — ứng viên
      mk("2026-08-01", "gan-san.mp4"), // 5 ngày — trong sàn 7 ngày
    ],
    { nowMs: now, floorDays: 7 },
  );
  assert.deepEqual(
    out.map((c) => c.absPath),
    ["cu-nhat.mp4", "cu.mp4"],
  );
});

test("orderSegmentCandidates: nhiều camera bị cắt ĐỀU theo ngày, không cạn từng cam", () => {
  const now = Date.parse("2026-08-06T12:00:00.000Z");
  const mk = (dayIso: string, cam: string): SegmentCandidate => ({
    absPath: `${cam}/${dayIso}.mp4`,
    dayMs: Date.parse(`${dayIso}T00:00:00.000Z`),
    cameraCode: cam,
  });
  const out = orderSegmentCandidates(
    [
      mk("2026-07-10", "CAM2"),
      mk("2026-07-01", "CAM2"),
      mk("2026-07-10", "CAM1"),
      mk("2026-07-01", "CAM1"),
    ],
    { nowMs: now, floorDays: 7 },
  );
  // Cả hai cam của ngày cũ nhất phải đứng trước bất kỳ file nào của ngày sau.
  assert.deepEqual(
    out.map((c) => c.absPath),
    ["CAM1/2026-07-01.mp4", "CAM2/2026-07-01.mp4", "CAM1/2026-07-10.mp4", "CAM2/2026-07-10.mp4"],
  );
});

test("orderSegmentCandidates: đệm múi giờ — ngày sát sàn KHÔNG bị xoá sớm", () => {
  const now = Date.parse("2026-08-06T12:00:00.000Z");
  // Thư mục 2026-07-30: cách 7 ngày tính theo đầu ngày UTC, nhưng ở UTC+7 nó
  // kết thúc muộn hơn → phải giữ, không được coi là vượt sàn.
  const out = orderSegmentCandidates(
    [{ absPath: "sat-san.mp4", dayMs: Date.parse("2026-07-30T00:00:00.000Z"), cameraCode: "C" }],
    { nowMs: now, floorDays: 7 },
  );
  assert.deepEqual(out, []);
});

// ============================================================================
// RepeatNotifier — chống ngập agent_log_events khi kẹt trạng thái kéo dài
// ============================================================================

test("RepeatNotifier: lần đầu báo ngay, các tick sát nhau thì im", () => {
  const n = new RepeatNotifier([30 * 60_000, 2 * 60 * 60_000]);
  const t0 = Date.parse("2026-08-06T00:00:00.000Z");
  assert.equal(n.shouldNotify("floor", t0), true);
  // 5 nhịp tick 5 phút tiếp theo (đúng chu kỳ guard) đều phải im.
  for (let i = 1; i <= 5; i++) {
    assert.equal(n.shouldNotify("floor", t0 + i * 5 * 60_000), false, `tick ${i}`);
  }
});

test("RepeatNotifier: nhắc lại giãn dần theo thang, không theo chu kỳ tick", () => {
  const n = new RepeatNotifier([30 * 60_000, 2 * 60 * 60_000]);
  const t0 = 0;
  assert.equal(n.shouldNotify("floor", t0), true);
  assert.equal(n.shouldNotify("floor", t0 + 30 * 60_000), true); // mốc 30'
  assert.equal(n.shouldNotify("floor", t0 + 60 * 60_000), false); // chưa đủ 2h
  assert.equal(n.shouldNotify("floor", t0 + 30 * 60_000 + 2 * 60 * 60_000), true);
});

test("RepeatNotifier: một ngày kẹt sàn ≤ 6 dòng (không phải 288)", () => {
  const n = new RepeatNotifier();
  let lines = 0;
  for (let t = 0; t <= 24 * 60 * 60_000; t += 5 * 60_000) {
    if (n.shouldNotify("floor", t)) lines++;
  }
  assert.ok(lines <= 6, `kỳ vọng ≤6 dòng/ngày, thực tế ${lines}`);
});

test("RepeatNotifier: clear trả true khi đang active, reset về đầu thang", () => {
  const n = new RepeatNotifier([30 * 60_000]);
  assert.equal(n.clear("floor"), false);
  n.shouldNotify("floor", 0);
  assert.equal(n.isActive("floor"), true);
  assert.equal(n.clear("floor"), true);
  // Vào lại trạng thái → báo ngay, không kế thừa bậc thang cũ.
  assert.equal(n.shouldNotify("floor", 1_000), true);
});

// ============================================================================
// readVolumeUsage (Windows: statfs nhận cả đường dẫn thư mục con)
// ============================================================================

test("readVolumeUsage: trả free/total > 0 cho thư mục thật", async () => {
  const root = await makeRoot();
  try {
    const usage = await readVolumeUsage(root);
    assert.ok(usage.totalBytes > 0, "totalBytes phải > 0");
    assert.ok(usage.freeBytes > 0, "freeBytes phải > 0");
    assert.ok(usage.freeBytes <= usage.totalBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ============================================================================
// tick() — hai nửa
// ============================================================================

/** Guard ép vào mức action bằng sàn tuyệt đối khổng lồ (mọi ổ đều "thiếu chỗ"). */
function forcedActionGuard(
  root: string,
  overrides: { isCutInFlight?: () => boolean } = {},
) {
  return new DiskGuard(
    {
      recordingRoot: root,
      getActiveCameras: () => [],
      isCutInFlight: overrides.isCutInFlight ?? (() => false),
    },
    {
      checkIntervalMs: 60_000,
      absoluteFloorBytes: Number.MAX_SAFE_INTEGER,
      floorDays: 7,
      batchSize: 5,
    },
  );
}

test("tick: NỬA DƯƠNG — segment cũ hơn sàn bị xoá", async () => {
  const root = await makeRoot();
  try {
    const now = Date.now();
    const old1 = await makeSegment(root, "CAM1", now - 30 * DAY_MS, "a.mp4");
    const old2 = await makeSegment(root, "CAM1", now - 20 * DAY_MS, "b.mp4");
    await forcedActionGuard(root).tick();
    assert.equal(existsSync(old1), false, "segment 30 ngày phải bị xoá");
    assert.equal(existsSync(old2), false, "segment 20 ngày phải bị xoá");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tick: NỬA ÂM — segment trong sàn và `_clips` KHÔNG bị đụng", async () => {
  const root = await makeRoot();
  try {
    const now = Date.now();
    const old = await makeSegment(root, "CAM1", now - 30 * DAY_MS, "old.mp4");
    const inFloor = await makeSegment(root, "CAM1", now - 2 * DAY_MS, "fresh.mp4");

    // Clip cũ hơn mọi segment — v1 KHÔNG được xoá clip dù đang thiếu chỗ.
    const clipsDir = path.join(root, "_clips");
    await mkdir(clipsDir, { recursive: true });
    const clipAbs = path.join(clipsDir, "abcdefab-cdef-4def-8def-abcdefabcdef.mp4");
    await writeFile(clipAbs, Buffer.alloc(4096));

    await forcedActionGuard(root).tick();

    assert.equal(existsSync(old), false, "segment ngoài sàn phải bị xoá");
    assert.equal(existsSync(inFloor), true, "segment trong sàn KHÔNG được đụng");
    assert.equal(existsSync(clipAbs), true, "_clips KHÔNG được đụng ở v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tick: NỬA ÂM — đang cắt clip thì hoãn, không xoá gì", async () => {
  const root = await makeRoot();
  try {
    const old = await makeSegment(root, "CAM1", Date.now() - 30 * DAY_MS, "a.mp4");
    await forcedActionGuard(root, { isCutInFlight: () => true }).tick();
    assert.equal(existsSync(old), true, "đang cắt clip → không được xoá segment");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tick: ổ còn nhiều chỗ + không đo được tốc độ → không xoá gì", async () => {
  const root = await makeRoot();
  try {
    const old = await makeSegment(root, "CAM1", Date.now() - 30 * DAY_MS, "a.mp4");
    const guard = new DiskGuard(
      { recordingRoot: root, getActiveCameras: () => [], isCutInFlight: () => false },
      { checkIntervalMs: 60_000, absoluteFloorBytes: 1024, floorDays: 7 },
    );
    await guard.tick();
    assert.equal(existsSync(old), true, "mức ok → không đụng file nào");
    assert.equal(guard.getStatus()?.level, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tick: cây rỗng ngoài sàn → chạm sàn, không ném lỗi", async () => {
  const root = await makeRoot();
  try {
    await makeSegment(root, "CAM1", Date.now() - 1 * DAY_MS, "fresh.mp4");
    await forcedActionGuard(root).tick();
    const files = await readdir(path.join(root, "CAM1"), { recursive: true });
    assert.ok(files.some((f) => String(f).endsWith("fresh.mp4")), "file trong sàn còn nguyên");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
