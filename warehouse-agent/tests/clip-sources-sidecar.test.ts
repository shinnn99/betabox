import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLIP_SOURCES_SUFFIX,
  writeClipSourcesSidecar,
  type ClipSourcesSidecar,
} from "../src/clip-cutter";

/**
 * Sidecar nguồn clip — chưa có ai đọc, ghi từ 2026-08-06 để disk guard v2
 * phân biệt clip-cache với clip-bản-cuối mà không phải đoán theo tuổi file.
 */

const PE = "abcdefab-cdef-4def-8def-abcdefabcdef";
const CLIP = "12345678-1234-4234-8234-123456789012";

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "clip-sources-test-"));
}

async function write(dir: string, sourceFiles: string[]): Promise<void> {
  await writeClipSourcesSidecar({
    clipsDir: dir,
    packingEventId: PE,
    clipId: CLIP,
    cameraId: "cam-uuid",
    targetStart: "2026-08-06T01:00:00.000Z",
    targetEnd: "2026-08-06T01:02:00.000Z",
    sourceFiles,
  });
}

test("writeClipSourcesSidecar: ghi cạnh clip, giữ đủ nguồn + dải thời gian", async () => {
  const dir = await makeDir();
  try {
    const sources = ["CAM1/2026/08/06/CAM1_20260806_010000.mp4", "CAM1/2026/08/06/CAM1_20260806_010100.mp4"];
    await write(dir, sources);

    const raw = await readFile(path.join(dir, `${PE}${CLIP_SOURCES_SUFFIX}`), "utf8");
    const parsed = JSON.parse(raw) as ClipSourcesSidecar;

    assert.equal(parsed.packing_event_id, PE);
    assert.equal(parsed.clip_id, CLIP);
    assert.deepEqual(parsed.source_files, sources);
    assert.equal(parsed.target_start, "2026-08-06T01:00:00.000Z");
    assert.ok(Date.parse(parsed.written_at) > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeClipSourcesSidecar: ghi lại (Safe Retry) đè sạch, không để lại .tmp", async () => {
  const dir = await makeDir();
  try {
    await write(dir, ["cu.mp4"]);
    await write(dir, ["moi-1.mp4", "moi-2.mp4"]);

    const raw = await readFile(path.join(dir, `${PE}${CLIP_SOURCES_SUFFIX}`), "utf8");
    const parsed = JSON.parse(raw) as ClipSourcesSidecar;
    assert.deepEqual(parsed.source_files, ["moi-1.mp4", "moi-2.mp4"]);

    const left = await readdir(dir);
    assert.deepEqual(left, [`${PE}${CLIP_SOURCES_SUFFIX}`], "không được để lại file .tmp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeClipSourcesSidecar: thư mục không tồn tại → ném lỗi (caller nuốt)", async () => {
  await assert.rejects(
    () => write(path.join(tmpdir(), "khong-ton-tai-abc123", "_clips"), ["a.mp4"]),
    /ENOENT/,
  );
});
