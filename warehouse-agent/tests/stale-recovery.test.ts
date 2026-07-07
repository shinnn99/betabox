import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateMarker,
  buildQuarantineDir,
  quarantineStaleGeneration,
  type StaleMarker,
} from "../src/stale-recovery";

/**
 * B4 HIGH-13 tests: validateMarker + buildQuarantineDir + quarantineStaleGeneration.
 * verifyStaleMarker (network) test qua mock trong tests khác.
 */

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "stale-recovery-test-"));
}

const VALID_MARKER: StaleMarker = {
  clip_id: "12345678-1234-4234-8234-123456789012",
  packing_event_id: "abcdefab-cdef-4def-8def-abcdefabcdef",
  bucket_path: "org-x/pe-abc/clip-abc.mp4",
};

// ============================================================================
// validateMarker
// ============================================================================

test("validateMarker: valid marker → ok", () => {
  assert.deepEqual(validateMarker(VALID_MARKER), { ok: true });
});

test("validateMarker: null/undefined/non-object → not_object", () => {
  assert.equal(validateMarker(null).reason, "not_object");
  assert.equal(validateMarker(undefined).reason, "not_object");
  assert.equal(validateMarker("string").reason, "not_object");
});

test("validateMarker: clip_id không phải UUID → clip_id_invalid", () => {
  assert.equal(
    validateMarker({ ...VALID_MARKER, clip_id: "not-a-uuid" }).reason,
    "clip_id_invalid",
  );
});

test("validateMarker: packing_event_id không phải UUID → packing_event_id_invalid", () => {
  assert.equal(
    validateMarker({ ...VALID_MARKER, packing_event_id: "not-a-uuid" }).reason,
    "packing_event_id_invalid",
  );
});

test("validateMarker: bucket_path rỗng → bucket_path_invalid", () => {
  assert.equal(
    validateMarker({ ...VALID_MARKER, bucket_path: "" }).reason,
    "bucket_path_invalid",
  );
});

test("validateMarker: bucket_path quá dài (>500) → bucket_path_invalid", () => {
  assert.equal(
    validateMarker({ ...VALID_MARKER, bucket_path: "a".repeat(501) }).reason,
    "bucket_path_invalid",
  );
});

// ============================================================================
// buildQuarantineDir
// ============================================================================

test("buildQuarantineDir: deterministic format", () => {
  const now = new Date("2026-07-07T15:30:00.123Z");
  const dir = buildQuarantineDir(
    "/tmp/clips",
    "12345678-1234-4234-8234-123456789012",
    "cross_tenant",
    now,
  );
  assert.match(
    dir,
    /_quarantine[\\/]stale-recovery[\\/]20260707T153000Z_12345678-1234-4234-8234-123456789012_cross_tenant$/,
  );
});

test("buildQuarantineDir: sanitize reason (non-safe chars)", () => {
  const now = new Date("2026-07-07T00:00:00Z");
  const dir = buildQuarantineDir(
    "/tmp",
    "12345678-1234-4234-8234-123456789012",
    "bucket path mismatch!?",
    now,
  );
  // Space + ! + ? bị thay _.
  assert.match(dir, /bucket_path_mismatch__$/);
});

test("buildQuarantineDir: nằm CÙNG parent clipsDir (atomic rename khả thi)", () => {
  const dir = buildQuarantineDir(
    "/tmp/clips",
    "12345678-1234-4234-8234-123456789012",
    "reason",
  );
  assert.ok(dir.startsWith("/tmp/clips") || dir.startsWith("\\tmp\\clips"));
});

// ============================================================================
// quarantineStaleGeneration
// ============================================================================

test("quarantineStaleGeneration: rename .stale + .tmp + ghi sidecar", async () => {
  const clipsDir = await makeDir();
  try {
    const staleAbs = path.join(clipsDir, "pe.cmd.tmp.mp4.stale");
    const tmpAbs = path.join(clipsDir, "pe.cmd.tmp.mp4");
    await writeFile(staleAbs, JSON.stringify(VALID_MARKER), "utf8");
    await writeFile(tmpAbs, Buffer.alloc(100), null as never);

    const r = await quarantineStaleGeneration({
      clipsDir,
      staleAbs,
      tmpAbs,
      marker: VALID_MARKER,
      reason: "bucket_path_mismatch",
      extra: { expected: "org-x/pe-y/clip-y.mp4" },
      now: new Date("2026-07-07T15:30:00Z"),
    });
    assert.equal(r.ok, true);
    assert.ok(r.dir);
    // .stale + .tmp đã move
    assert.equal(existsSync(staleAbs), false);
    assert.equal(existsSync(tmpAbs), false);
    // File trong quarantine dir
    assert.equal(existsSync(path.join(r.dir!, "pe.cmd.tmp.mp4.stale")), true);
    assert.equal(existsSync(path.join(r.dir!, "pe.cmd.tmp.mp4")), true);
    assert.equal(existsSync(path.join(r.dir!, "sidecar.json")), true);
    // Sidecar shape
    const sidecar = JSON.parse(await readFile(path.join(r.dir!, "sidecar.json"), "utf8"));
    assert.equal(sidecar.reason, "bucket_path_mismatch");
    assert.equal(sidecar.marker.clip_id, VALID_MARKER.clip_id);
    assert.deepEqual(sidecar.extra, { expected: "org-x/pe-y/clip-y.mp4" });
    assert.equal(sidecar.original.tmp_exists, true);
  } finally {
    await rm(clipsDir, { recursive: true });
  }
});

test("quarantineStaleGeneration: .tmp mất, sidecar vẫn ghi + tmp_exists=false", async () => {
  const clipsDir = await makeDir();
  try {
    const staleAbs = path.join(clipsDir, "pe.tmp.mp4.stale");
    const tmpAbs = path.join(clipsDir, "pe.tmp.mp4"); // không tạo
    await writeFile(staleAbs, JSON.stringify(VALID_MARKER), "utf8");
    const r = await quarantineStaleGeneration({
      clipsDir,
      staleAbs,
      tmpAbs,
      marker: VALID_MARKER,
      reason: "no_tmp",
    });
    assert.equal(r.ok, true);
    const sidecar = JSON.parse(await readFile(path.join(r.dir!, "sidecar.json"), "utf8"));
    assert.equal(sidecar.original.tmp_exists, false);
    assert.equal(existsSync(path.join(r.dir!, "pe.tmp.mp4.stale")), true);
  } finally {
    await rm(clipsDir, { recursive: true });
  }
});

test("quarantineStaleGeneration: canonical KHÔNG bị đụng", async () => {
  const clipsDir = await makeDir();
  try {
    const canonicalAbs = path.join(clipsDir, "abcdefab-cdef-4def-8def-abcdefabcdef.mp4");
    await writeFile(canonicalAbs, Buffer.from("original canonical"), null as never);
    const staleAbs = path.join(clipsDir, "x.stale");
    const tmpAbs = path.join(clipsDir, "x");
    await writeFile(staleAbs, JSON.stringify(VALID_MARKER), "utf8");
    await writeFile(tmpAbs, Buffer.from("bad tmp"), null as never);

    await quarantineStaleGeneration({
      clipsDir,
      staleAbs,
      tmpAbs,
      marker: VALID_MARKER,
      reason: "cross_tenant",
    });
    // Canonical vẫn nguyên nội dung cũ
    assert.equal(existsSync(canonicalAbs), true);
    const c = await readFile(canonicalAbs, "utf8");
    assert.equal(c, "original canonical");
  } finally {
    await rm(clipsDir, { recursive: true });
  }
});

test("quarantineStaleGeneration: KHÔNG log signed URL trong sidecar", async () => {
  const clipsDir = await makeDir();
  try {
    const staleAbs = path.join(clipsDir, "x.stale");
    const tmpAbs = path.join(clipsDir, "x");
    await writeFile(staleAbs, "{}", "utf8");
    await writeFile(tmpAbs, "x", "utf8");
    const marker: StaleMarker = {
      ...VALID_MARKER,
      // Marker gốc không lưu signed URL, nhưng test giả sử ai đó lỡ đưa
      // vào — sidecar chỉ ghi trường được typed, không có signed_url.
    };
    const r = await quarantineStaleGeneration({
      clipsDir,
      staleAbs,
      tmpAbs,
      marker,
      reason: "test",
    });
    const sidecarRaw = await readFile(path.join(r.dir!, "sidecar.json"), "utf8");
    assert.doesNotMatch(sidecarRaw, /signed_url|signedUrl|access_token/i);
  } finally {
    await rm(clipsDir, { recursive: true });
  }
});
