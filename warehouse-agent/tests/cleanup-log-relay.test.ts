import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CleanupLogRelay, analyzeCleanupLines } from "../src/cleanup-log-relay";

/**
 * Relay log cleanup: phát lại nội dung + báo im lặng.
 *
 * Bắt console.warn/error để khẳng định ĐÚNG thứ được phát — remote-logger
 * chỉ đẩy warn/error lên cloud, nên dòng nào ở cấp nào là chuyện đúng/sai
 * chứ không phải thẩm mỹ.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function captureConsole() {
  const warns: string[] = [];
  const errors: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  return {
    warns,
    errors,
    restore() {
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "cleanup-relay-test-"));
}

const SUMMARY = "[2026-08-23 03:00:12] [INFO] === Cleanup done: deleted=412 files freed=3210.4MB empty_folders_removed=9 ===";
const ERR_CACHE = "[2026-08-23 03:00:01] [ERROR] retention-cache.json không tìm thấy tại C:\\x. Cleanup KHÔNG chạy.";

// ============================================================================
// analyzeCleanupLines
// ============================================================================

test("analyze: lượt dọn thành công → có tổng kết, không có lỗi", () => {
  const a = analyzeCleanupLines(["[INFO] start", SUMMARY]);
  assert.equal(a.errorLines.length, 0);
  assert.ok(a.lastSummary?.includes("deleted=412"));
  assert.equal(a.ranWithoutCleanup, false);
});

test("analyze: exit 2 → ranWithoutCleanup (trạng thái tự duy trì)", () => {
  const a = analyzeCleanupLines(["[INFO] start", ERR_CACHE]);
  assert.equal(a.errorLines.length, 1);
  assert.equal(a.lastSummary, null);
  assert.equal(a.ranWithoutCleanup, true);
});

test("analyze: lỗi rồi tuần sau chạy được → KHÔNG còn là ranWithoutCleanup", () => {
  const a = analyzeCleanupLines([ERR_CACHE, SUMMARY]);
  assert.equal(a.errorLines.length, 1);
  assert.equal(a.ranWithoutCleanup, false);
});

test("analyze: lấy tổng kết MỚI NHẤT khi có nhiều lượt", () => {
  const older = SUMMARY.replace("deleted=412", "deleted=10");
  const a = analyzeCleanupLines([older, SUMMARY]);
  assert.ok(a.lastSummary?.includes("deleted=412"));
});

// ============================================================================
// check() — phát lại
// ============================================================================

test("check: phát tổng kết qua warn, KHÔNG phát lại ở lượt sau", async () => {
  const dir = await makeDir();
  const cap = captureConsole();
  try {
    const logPath = path.join(dir, "cleanup.log");
    await writeFile(logPath, SUMMARY + "\n", "utf8");
    const relay = new CleanupLogRelay({
      logPath,
      statePath: path.join(dir, "state.json"),
    });

    await relay.check();
    assert.equal(cap.warns.filter((l) => l.includes("deleted=412")).length, 1);

    await relay.check();
    assert.equal(
      cap.warns.filter((l) => l.includes("deleted=412")).length,
      1,
      "không được phát lại cùng một dòng",
    );

    // Lượt dọn mới xuất hiện → phát tiếp.
    await appendFile(logPath, SUMMARY.replace("deleted=412", "deleted=7") + "\n", "utf8");
    await relay.check();
    assert.equal(cap.warns.filter((l) => l.includes("deleted=7")).length, 1);
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: exit 2 → error + cảnh báo trạng thái tự duy trì", async () => {
  const dir = await makeDir();
  const cap = captureConsole();
  try {
    const logPath = path.join(dir, "cleanup.log");
    await writeFile(logPath, ERR_CACHE + "\n", "utf8");
    await new CleanupLogRelay({
      logPath,
      statePath: path.join(dir, "state.json"),
    }).check();

    assert.ok(cap.errors.some((l) => l.includes("retention-cache.json không tìm thấy")));
    assert.ok(cap.errors.some((l) => l.includes("tự duy trì")));
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: state sống qua restart — instance mới không phát lại", async () => {
  const dir = await makeDir();
  const cap = captureConsole();
  try {
    const logPath = path.join(dir, "cleanup.log");
    const statePath = path.join(dir, "state.json");
    await writeFile(logPath, SUMMARY + "\n", "utf8");
    await new CleanupLogRelay({ logPath, statePath }).check();
    await new CleanupLogRelay({ logPath, statePath }).check();
    assert.equal(cap.warns.filter((l) => l.includes("deleted=412")).length, 1);
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: file bị cắt ngắn → đọc lại từ đầu, không im lặng", async () => {
  const dir = await makeDir();
  const cap = captureConsole();
  try {
    const logPath = path.join(dir, "cleanup.log");
    const statePath = path.join(dir, "state.json");
    await writeFile(logPath, SUMMARY + "\n" + SUMMARY + "\n", "utf8");
    await new CleanupLogRelay({ logPath, statePath }).check();

    // Xoay vòng: file ngắn lại, nội dung mới.
    await writeFile(logPath, SUMMARY.replace("deleted=412", "deleted=3") + "\n", "utf8");
    await new CleanupLogRelay({ logPath, statePath }).check();

    assert.ok(cap.warns.some((l) => l.includes("ngắn lại")));
    assert.ok(cap.warns.some((l) => l.includes("deleted=3")));
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// check() — báo im lặng
// ============================================================================

test("check: log cũ hơn ngưỡng → error IM LẶNG", async () => {
  const dir = await makeDir();
  const cap = captureConsole();
  try {
    const logPath = path.join(dir, "cleanup.log");
    await writeFile(logPath, SUMMARY + "\n", "utf8");
    const old = (Date.now() - 20 * DAY_MS) / 1000;
    await utimes(logPath, old, old);

    await new CleanupLogRelay(
      { logPath, statePath: path.join(dir, "state.json") },
      { silenceThresholdMs: 15 * DAY_MS },
    ).check();

    assert.ok(cap.errors.some((l) => l.includes("IM LẶNG")));
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: log mới → KHÔNG báo im lặng", async () => {
  const dir = await makeDir();
  const cap = captureConsole();
  try {
    const logPath = path.join(dir, "cleanup.log");
    await writeFile(logPath, SUMMARY + "\n", "utf8");
    await new CleanupLogRelay(
      { logPath, statePath: path.join(dir, "state.json") },
      { silenceThresholdMs: 15 * DAY_MS },
    ).check();
    assert.equal(cap.errors.filter((l) => l.includes("IM LẶNG")).length, 0);
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: im lặng kéo dài KHÔNG log mỗi nhịp (thang giãn dần)", async () => {
  const dir = await makeDir();
  const cap = captureConsole();
  try {
    const logPath = path.join(dir, "cleanup.log");
    await writeFile(logPath, SUMMARY + "\n", "utf8");
    const old = (Date.now() - 40 * DAY_MS) / 1000;
    await utimes(logPath, old, old);

    const relay = new CleanupLogRelay(
      { logPath, statePath: path.join(dir, "state.json") },
      { silenceThresholdMs: 15 * DAY_MS },
    );
    for (let i = 0; i < 5; i++) await relay.check();

    assert.equal(
      cap.errors.filter((l) => l.includes("IM LẶNG")).length,
      1,
      "5 nhịp liên tiếp chỉ được báo 1 lần",
    );
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: chưa có log → warn MỘT LẦN, không kêu mỗi nhịp", async () => {
  const dir = await makeDir();
  const cap = captureConsole();
  try {
    const relay = new CleanupLogRelay({
      logPath: path.join(dir, "khong-ton-tai.log"),
      statePath: path.join(dir, "state.json"),
    });
    await relay.check();
    await relay.check();
    await relay.check();
    assert.equal(cap.warns.filter((l) => l.includes("chưa chạy lần nào")).length, 1);
    assert.equal(cap.errors.length, 0, "máy vừa cài không được báo động đỏ");
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
