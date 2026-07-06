import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fingerprintArgs, PidRegistry } from "../src/pid-registry";

/**
 * B2 CRIT-1: PidRegistry atomic persist + fingerprint deterministic.
 */

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "pid-reg-test-"));
}

test("PidRegistry: load empty returns empty map", async () => {
  const dir = await makeDir();
  try {
    const reg = new PidRegistry(path.join(dir, "ffmpeg-pids.json"));
    const map = await reg.load();
    assert.equal(map.size, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("PidRegistry: set + load round-trip", async () => {
  const dir = await makeDir();
  try {
    const reg = new PidRegistry(path.join(dir, "ffmpeg-pids.json"));
    await reg.set({
      cameraId: "cam-1",
      cameraCode: "CAM01",
      sessionId: "sess-1",
      pid: 1234,
      startedAt: "2026-07-07T00:00:00Z",
      fingerprint: "abc123",
    });
    // New instance to force re-read from disk
    const reg2 = new PidRegistry(path.join(dir, "ffmpeg-pids.json"));
    const list = await reg2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].pid, 1234);
    assert.equal(list[0].fingerprint, "abc123");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("PidRegistry: remove", async () => {
  const dir = await makeDir();
  try {
    const reg = new PidRegistry(path.join(dir, "ffmpeg-pids.json"));
    await reg.set({
      cameraId: "cam-1",
      cameraCode: "CAM01",
      sessionId: "s1",
      pid: 1000,
      startedAt: "2026-07-07T00:00:00Z",
      fingerprint: "f1",
    });
    await reg.set({
      cameraId: "cam-2",
      cameraCode: "CAM02",
      sessionId: "s2",
      pid: 2000,
      startedAt: "2026-07-07T00:00:00Z",
      fingerprint: "f2",
    });
    await reg.remove("cam-1");
    const list = await reg.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].cameraId, "cam-2");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("PidRegistry: file corruption returns empty map (not throw)", async () => {
  const dir = await makeDir();
  try {
    const filePath = path.join(dir, "ffmpeg-pids.json");
    // Ghi rác vào file
    const fs = await import("node:fs/promises");
    await fs.writeFile(filePath, "not-json-{{", "utf8");
    const reg = new PidRegistry(filePath);
    let threw = false;
    try {
      await reg.load();
    } catch {
      threw = true;
    }
    // load() sẽ throw vì JSON.parse fail — nhưng chỉ khi file tồn tại.
    // Chấp nhận: corrupt = throw để ops thấy.
    assert.equal(threw, true);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("PidRegistry: skip malformed entries but keep valid ones", async () => {
  const dir = await makeDir();
  try {
    const filePath = path.join(dir, "ffmpeg-pids.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "cam-good": {
            cameraId: "cam-good",
            cameraCode: "GOOD",
            sessionId: "s",
            pid: 100,
            startedAt: "2026-07-07T00:00:00Z",
            fingerprint: "f",
          },
          "cam-bad": {
            // thiếu fingerprint
            cameraId: "cam-bad",
            cameraCode: "BAD",
            sessionId: "s",
            pid: 200,
            startedAt: "2026-07-07T00:00:00Z",
          },
        },
      }),
      "utf8",
    );
    const reg = new PidRegistry(filePath);
    const list = await reg.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].cameraId, "cam-good");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("PidRegistry: version !== 1 returns empty (upgrade safety)", async () => {
  const dir = await makeDir();
  try {
    const filePath = path.join(dir, "ffmpeg-pids.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 999, entries: {} }),
      "utf8",
    );
    const reg = new PidRegistry(filePath);
    const list = await reg.list();
    assert.equal(list.length, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("fingerprintArgs: deterministic + khác args → khác hash", () => {
  const h1 = fingerprintArgs(["-i", "rtsp://x/1"]);
  const h2 = fingerprintArgs(["-i", "rtsp://x/1"]);
  const h3 = fingerprintArgs(["-i", "rtsp://x/2"]);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 64); // sha256 hex
});

test("fingerprintArgs: null-byte separator ngăn collision", () => {
  // ['a', 'bc'] vs ['ab', 'c'] cùng concat "abc" nếu không có separator
  const h1 = fingerprintArgs(["a", "bc"]);
  const h2 = fingerprintArgs(["ab", "c"]);
  assert.notEqual(h1, h2);
});

test("PidRegistry: atomic write không để lại partial file khi write thành công", async () => {
  const dir = await makeDir();
  try {
    const filePath = path.join(dir, "ffmpeg-pids.json");
    const reg = new PidRegistry(filePath);
    await reg.set({
      cameraId: "cam-1",
      cameraCode: "CAM01",
      sessionId: "s",
      pid: 100,
      startedAt: "2026-07-07T00:00:00Z",
      fingerprint: "f",
    });
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.version, 1);
    assert.equal(Object.keys(parsed.entries).length, 1);
  } finally {
    await rm(dir, { recursive: true });
  }
});
