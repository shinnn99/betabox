import { spawn } from "node:child_process";
import { mkdir, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * Cắt clip từ segment thô — chỉ `-c copy`, không vẽ gì lên video.
 *
 * Kiến trúc chốt 2026-07-05 — VIDEO THUẦN:
 *   - Cut: copy-stream 100% clip. Không burn mã, không vẽ dấu gap,
 *     không overlay giao diện. Vài giây/clip 10 phút.
 *   - Phát hiện gap: cloud tính (enqueue.ts) để feed
 *     `order_proof_clips.is_partial` + `covered_range` — hiện ở panel
 *     thông tin đơn cạnh video trong dashboard, không đụng video.
 *   - Thông tin đơn (mã vận đơn/kho/bàn/nhân viên/camera/thời gian):
 *     panel dashboard đọc từ scan.waybill_code + join scan.warehouse/
 *     station/staff/camera. Không đè lên hình.
 *
 * Toàn bộ code burn/mark (renderGapMark, buildInterleavedConcatList,
 * buildBurnInFilter, formatVnDateTime, BurnInParams, GapMark, BurnPosition)
 * đã xoá 2026-07-05. Không có kế hoạch thêm lại — Hạnh chốt bỏ luôn
 * overlay + burn on-demand vì mã đã có trong video gốc (nhân viên quét
 * mã trước camera) + panel dashboard.
 */

export interface CutSegmentInput {
  file_path: string; // relative to recordingRoot
  started_at: string; // ISO UTC
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface CutClipParams {
  ffmpegBin: string;
  ffprobeBin: string;
  recordingRoot: string;
  outputAbsPath: string; // <recordingRoot>/_clips/<packing_event_id>.mp4
  cutStart: Date;
  cutEnd: Date;
  segments: CutSegmentInput[]; // sorted by started_at
  timeoutMs?: number;
}

export interface CutClipResult {
  ok: boolean;
  errorMessage?: string;
  fileSizeBytes: number;
  durationSeconds: number;
  durationDriftSeconds: number;
  stderrTail: string;
  elapsedMs: number;
}

function buildConcatList(segments: CutSegmentInput[], recordingRoot: string): string {
  return (
    segments
      .map((s) => {
        const abs = path.join(recordingRoot, s.file_path);
        // Escape single quote for ffmpeg concat file format.
        const escaped = abs.replaceAll("'", "'\\''");
        return `file '${escaped}'`;
      })
      .join("\n") + "\n"
  );
}

export async function cutClip(params: CutClipParams): Promise<CutClipResult> {
  const started = Date.now();
  const outDir = path.dirname(params.outputAbsPath);
  await mkdir(outDir, { recursive: true });

  const listPath = `${params.outputAbsPath}.concat.txt`;
  const concatBody = buildConcatList(params.segments, params.recordingRoot);
  await writeFile(listPath, concatBody, "utf8");

  const cleanupTmp = async () => {
    await unlink(listPath).catch(() => undefined);
  };

  // Offset trong concat stream ảo, tính từ started_at của segment
  // đầu tiên. `Date.parse`/`getTime()` hoạt động trên UTC millis —
  // TZ máy không ảnh hưởng.
  const firstStart = Date.parse(params.segments[0].started_at);
  const ssSeconds = Math.max(0, (params.cutStart.getTime() - firstStart) / 1000);
  const tSeconds = Math.max(
    0,
    (params.cutEnd.getTime() - params.cutStart.getTime()) / 1000,
  );

  // `-ss` đặt SAU `-i` (không phải trước). Đây là ca đặc biệt của
  // concat demuxer:
  //
  // Với input file đơn có index (mp4/mkv), `-ss` trước `-i` là INPUT
  // SEEK — nhảy tới keyframe gần mốc, nhanh. Cả input seek và output
  // seek đều snap keyframe với `-c copy`, không có "accurate seek".
  //
  // NHƯNG concat demuxer KHÔNG hỗ trợ input seek. Concat tạo virtual
  // stream nối các file — không có index toàn cục để tra. Đặt `-ss`
  // trước `-i` với `-f concat` → ffmpeg BỎ QUA seek, cắt ra clip
  // không đúng khoảng (verified: clip 74s thay vì 29s target khi
  // dùng `-ss` trước với concat).
  //
  // Kết luận: dùng `-ss` sau `-i` cho concat. Nhược điểm: ffmpeg
  // phải parse timestamps của mọi packet trước mốc (không decode
  // video, chỉ đọc container) — chậm hơn input seek nhưng vẫn nhanh
  // vì packet parsing rất rẻ. Với 2-3 segment mp4 ≤ 60s mỗi cái,
  // tốn ~100-300ms, không cướp CPU đáng kể của recording.
  const args: string[] = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-ss", ssSeconds.toFixed(3),
    "-t", tSeconds.toFixed(3),
    "-c", "copy",
    "-bsf:v", "dump_extra",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    params.outputAbsPath,
  ];

  const timeoutMs = params.timeoutMs ?? 60_000;

  let stderrTail = "";
  try {
    stderrTail = await new Promise<string>((resolve, reject) => {
      let proc;
      try {
        proc = spawn(params.ffmpegBin, args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        return reject(err);
      }
      let buf = "";
      const cap = 8_000;
      proc.stdout?.on("data", () => {});
      proc.stderr?.on("data", (chunk: Buffer) => {
        buf = (buf + chunk.toString("utf8")).slice(-cap);
      });
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
      }, timeoutMs);
      proc.on("close", () => {
        clearTimeout(t);
        resolve(buf.trim());
      });
      proc.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
  } catch (err) {
    await cleanupTmp();
    return {
      ok: false,
      errorMessage: `spawn failed: ${(err as Error).message}`,
      fileSizeBytes: 0,
      durationSeconds: 0,
      durationDriftSeconds: 0,
      stderrTail: "",
      elapsedMs: Date.now() - started,
    };
  }

  await cleanupTmp();

  let size = 0;
  try {
    const st = await stat(params.outputAbsPath);
    size = st.size;
  } catch {
    // file not created — failure
  }

  const elapsedMs = Date.now() - started;

  if (size <= 0) {
    return {
      ok: false,
      errorMessage:
        "Không tạo được file clip. " +
        (stderrTail ? "Chi tiết: " + stderrTail.split("\n").slice(-3).join(" | ") : ""),
      fileSizeBytes: 0,
      durationSeconds: 0,
      durationDriftSeconds: 0,
      stderrTail,
      elapsedMs,
    };
  }

  const probed = await probeDurationSeconds(params.ffprobeBin, params.outputAbsPath);
  const durationSeconds = probed ?? tSeconds;
  const durationDriftSeconds = probed === null ? 0 : Math.abs(tSeconds - probed);

  return {
    ok: true,
    fileSizeBytes: size,
    durationSeconds,
    durationDriftSeconds,
    stderrTail,
    elapsedMs,
  };
}

/**
 * Codec guard (safe-retry S5 2026-07-06): CHỈ H.264.
 *
 * Kiến trúc chốt "camera ghi H.264 từ đầu" nên codec khác = bất thường.
 * Không tự động reencode (chốt) — raise fail rõ ràng để ops điều tra.
 *
 * ffprobe trả 2 field khác nhau cho H.264:
 *   stream.codec_name       → "h264"     (định danh codec)
 *   stream.codec_tag_string → "avc1"     (fourcc tag trong container mp4)
 *
 * Hợp lệ khi: codec_name = 'h264' HOẶC codec_tag_string = 'avc1'.
 *
 * Danh sách fail rõ ràng (kỳ vọng camera phát): hevc/h265, mjpeg,
 * vp8/vp9/av1, hoặc empty/probe failed.
 */
export interface ProbedCodec {
  /** stream.codec_name lowercase, VD "h264", "hevc". null nếu không có video stream. */
  codecName: string | null;
  /** stream.codec_tag_string lowercase, VD "avc1", "hev1". null nếu ffprobe không expose. */
  codecTag: string | null;
  /** True khi ffprobe chạy xong không lỗi (dù có video stream hay không). */
  probed: boolean;
}

export function isBrowserSafeCodec(probed: ProbedCodec): boolean {
  const name = probed.codecName?.toLowerCase() ?? null;
  const tag = probed.codecTag?.toLowerCase() ?? null;
  return name === "h264" || tag === "avc1";
}

/**
 * Probe codec name + tag của video stream đầu tiên trong 1 file.
 * Trả cả 2 field vì ffprobe có build khác nhau — vài build ưu tiên
 * codec_tag_string (mp4 container) thay vì codec_name.
 */
export async function probeFileVideoCodec(
  bin: string,
  filePath: string,
): Promise<ProbedCodec> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        bin,
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=codec_name,codec_tag_string",
          "-of", "default=noprint_wrappers=1",
          filePath,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      return resolve({ codecName: null, codecTag: null, probed: false });
    }
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    proc.stderr?.on("data", () => {});
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 10_000);
    proc.on("error", () => {
      clearTimeout(t);
      resolve({ codecName: null, codecTag: null, probed: false });
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return resolve({ codecName: null, codecTag: null, probed: false });
      // Parse key=value output. VD:
      //   codec_name=h264
      //   codec_tag_string=avc1
      let codecName: string | null = null;
      let codecTag: string | null = null;
      for (const line of out.split(/\r?\n/)) {
        const idx = line.indexOf("=");
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().toLowerCase();
        if (!val) continue;
        if (key === "codec_name") codecName = val;
        else if (key === "codec_tag_string") codecTag = val;
      }
      resolve({ codecName, codecTag, probed: true });
    });
  });
}

export async function probeDurationSeconds(bin: string, filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        bin,
        [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          filePath,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      return resolve(null);
    }
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    proc.stderr?.on("data", () => {});
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 10_000);
    proc.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return resolve(null);
      const n = Number(out.trim());
      if (!Number.isFinite(n) || n < 0) return resolve(null);
      resolve(n);
    });
  });
}

export async function checkSegmentsExist(params: {
  recordingRoot: string;
  segments: CutSegmentInput[];
}): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  for (const s of params.segments) {
    const abs = path.join(params.recordingRoot, s.file_path);
    if (!existsSync(abs)) missing.push(s.file_path);
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

/**
 * Boot cleanup (S10 safe-retry 2026-07-06).
 *
 * Xử 3 loại file tồn đọng trong _clips:
 *   - `.concat.txt` orphan → xóa mọi cái (rẻ, không có ý nghĩa gì).
 *   - `.stale` marker (json) + `.tmp.mp4` cùng name →
 *     đây là generation ĐÃ ready (bucket + DB) nhưng local rename fail.
 *     Recovery: rename tmp → canonical `{pe_id}.mp4`, xóa .stale + .bak.
 *   - `.tmp.mp4` KHÔNG có .stale marker + tuổi > `staleThresholdMs` →
 *     temp mồ côi (agent crash giữa cut). Xóa.
 *   - `.bak.mp4` tuổi > threshold → bak mồ côi, xóa.
 *
 * Recovery `.stale`: KHÔNG áp threshold — chạy recovery ngay lập tức
 * bất kể tuổi (marker ghi rõ tmp thuộc generation nào).
 */
export interface CleanupResult {
  concat_removed: number;
  stale_recovered: number;
  stale_recovery_failed: number;
  tmp_orphan_removed: number;
  bak_orphan_removed: number;
}

const CLIP_STALE_MARKER_SUFFIX = ".stale";
const CLIP_TMP_SUFFIX = ".tmp.mp4";
const CLIP_BAK_SUFFIX = ".bak.mp4";
const CLIP_CONCAT_SUFFIX = ".concat.txt";

/**
 * HIGH-13 (B4): DB verifier — inject qua args. Nếu undefined, recovery
 * skip (an toàn: giữ nguyên .stale + .tmp, KHÔNG xóa canonical) và tăng
 * counter stale_recovery_failed để ops thấy.
 *
 * Trả StaleVerdict typed: 'recover' → OK rename; 'quarantine' → agent
 * move file sang _quarantine/; 'unavailable' → skip cycle này.
 */
export interface StaleRecoveryDeps {
  verifyMarker: (marker: import("./stale-recovery").StaleMarker) =>
    Promise<import("./stale-recovery").StaleVerdict>;
  quarantine: (args: import("./stale-recovery").QuarantineArgs) =>
    Promise<{ ok: boolean; dir?: string; error?: string }>;
}

export async function cleanupOrphanClipArtifacts(
  clipsDir: string,
  staleThresholdMs = 24 * 60 * 60 * 1000,
  deps?: StaleRecoveryDeps,
): Promise<CleanupResult> {
  const fs = await import("node:fs/promises");
  const out: CleanupResult = {
    concat_removed: 0,
    stale_recovered: 0,
    stale_recovery_failed: 0,
    tmp_orphan_removed: 0,
    bak_orphan_removed: 0,
  };
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(clipsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();

  // PASS 1: recovery `.stale` markers. Đọc trước để không sweep nhầm
  // các .tmp mà .stale chỉ tới.
  const staleFiles = entries.filter(
    (e) => e.isFile() && e.name.endsWith(CLIP_STALE_MARKER_SUFFIX),
  );
  const recoveredTmpNames = new Set<string>();

  for (const staleEntry of staleFiles) {
    const staleAbs = path.join(clipsDir, staleEntry.name);
    // Tmp file tương ứng: cắt .stale suffix
    const tmpName = staleEntry.name.slice(0, -CLIP_STALE_MARKER_SUFFIX.length);
    const tmpAbs = path.join(clipsDir, tmpName);

    let markerContent: import("./stale-recovery").StaleMarker | null = null;
    try {
      const raw = await fs.readFile(staleAbs, "utf8");
      markerContent = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `[clip-cleanup] read .stale marker failed ${staleEntry.name}: ${(err as Error).message}`,
      );
      out.stale_recovery_failed++;
      continue;
    }

    // HIGH-13 (B4): validate marker shape TRƯỚC khi bất cứ đụng canonical
    // nào. Corrupt marker → quarantine ngay (nếu deps.quarantine available)
    // hoặc skip (safe fallback).
    const { validateMarker, buildQuarantineDir: _unused } = await import(
      "./stale-recovery"
    );
    void _unused;
    const shapeCheck = validateMarker(markerContent);
    if (!shapeCheck.ok) {
      if (deps?.quarantine && markerContent) {
        const q = await deps.quarantine({
          clipsDir,
          staleAbs,
          tmpAbs,
          marker: markerContent as import("./stale-recovery").StaleMarker,
          reason: `marker_${shapeCheck.reason}`,
        });
        console.warn(
          `[clip-cleanup] stale marker malformed reason=${shapeCheck.reason} quarantine_ok=${q.ok} dir=${q.dir ?? "-"}`,
        );
      } else {
        console.warn(
          `[clip-cleanup] stale marker malformed reason=${shapeCheck.reason} — no quarantine helper, skip`,
        );
      }
      out.stale_recovery_failed++;
      continue;
    }

    const peId = markerContent!.packing_event_id;

    if (!existsSync(tmpAbs)) {
      // Tmp mất — recovery không làm được. Xóa marker mồ côi.
      console.warn(
        `[clip-cleanup] .stale marker có nhưng tmp mất: ${staleEntry.name}`,
      );
      await fs.unlink(staleAbs).catch(() => undefined);
      out.stale_recovery_failed++;
      continue;
    }

    // HIGH-13 (B4): DB-verified recovery. Backend so clip_id+pe_id+
    // bucket_path với order_proof_clips. Nếu backend unavailable, GIỮ
    // nguyên .stale + .tmp (không xóa canonical) và tăng counter cho ops.
    if (!deps?.verifyMarker) {
      // No verifier available — không thực hiện recovery an toàn.
      // Giữ nguyên file, tăng counter để ops thấy.
      console.warn(
        `[clip-cleanup] stale recovery skipped pe=${peId} — no verifier configured`,
      );
      out.stale_recovery_failed++;
      continue;
    }

    const verdict = await deps.verifyMarker(markerContent!);
    if (verdict.kind === "unavailable") {
      // Backend không trả lời được. Giữ nguyên .stale + .tmp cho lần
      // cleanup sau. KHÔNG xóa canonical.
      console.warn(
        `[clip-cleanup] stale recovery unavailable pe=${peId} reason=${verdict.reason} — leaving files intact`,
      );
      out.stale_recovery_failed++;
      continue;
    }
    if (verdict.kind === "quarantine") {
      if (!deps.quarantine) {
        console.warn(
          `[clip-cleanup] stale marker quarantine verdict but no quarantine helper reason=${verdict.reason}`,
        );
        out.stale_recovery_failed++;
        continue;
      }
      const q = await deps.quarantine({
        clipsDir,
        staleAbs,
        tmpAbs,
        marker: markerContent!,
        reason: verdict.reason,
        extra: verdict.extra,
      });
      console.warn(
        `[clip-cleanup] stale generation quarantined pe=${peId} reason=${verdict.reason} quarantine_ok=${q.ok} dir=${q.dir ?? "-"} — canonical NOT touched`,
      );
      out.stale_recovery_failed++;
      continue;
    }

    // verdict.kind === 'recover'
    const canonicalAbs = path.join(clipsDir, `${peId}.mp4`);
    try {
      // Nếu canonical hiện tại tồn tại (clip cũ), unlink trước.
      // Safe-retry: DB đã trỏ bucket ĐÚNG clip_id (verifier đã match),
      // canonical này là clip cũ đã superseded → xóa an toàn.
      if (existsSync(canonicalAbs)) {
        await fs.unlink(canonicalAbs);
      }
      await fs.rename(tmpAbs, canonicalAbs);
      await fs.unlink(staleAbs).catch(() => undefined);
      // Xóa .bak nếu có
      const bakName = tmpName.replace(CLIP_TMP_SUFFIX, CLIP_BAK_SUFFIX);
      const bakAbs = path.join(clipsDir, bakName);
      if (existsSync(bakAbs)) {
        await fs.unlink(bakAbs).catch(() => undefined);
      }
      recoveredTmpNames.add(tmpName);
      out.stale_recovered++;
      console.log(
        `[clip-cleanup] recovered stale generation (DB-verified): pe=${peId} tmp=${tmpName} → canonical`,
      );
    } catch (err) {
      console.error(
        `[clip-cleanup] stale recovery rename failed pe=${peId}: ${(err as Error).message}`,
      );
      out.stale_recovery_failed++;
    }
  }

  // PASS 2: sweep orphans (concat, tmp không có marker, bak không recovery).
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(clipsDir, e.name);

    if (e.name.endsWith(CLIP_CONCAT_SUFFIX)) {
      await fs.unlink(abs).catch(() => undefined);
      out.concat_removed++;
      continue;
    }

    if (e.name.endsWith(CLIP_TMP_SUFFIX)) {
      if (recoveredTmpNames.has(e.name)) continue; // đã rename ở PASS 1
      // KHÔNG sweep nếu .stale marker cùng name còn tồn tại (recovery
      // fail — giữ để ops xem lại thủ công).
      const staleAbs = `${abs}${CLIP_STALE_MARKER_SUFFIX}`;
      if (existsSync(staleAbs)) continue;
      // Không marker → temp mồ côi. Chỉ xóa nếu tuổi > threshold.
      try {
        const st = await fs.stat(abs);
        if (now - st.mtimeMs > staleThresholdMs) {
          await fs.unlink(abs).catch(() => undefined);
          out.tmp_orphan_removed++;
        }
      } catch {
        // stat lỗi — bỏ qua
      }
      continue;
    }

    if (e.name.endsWith(CLIP_BAK_SUFFIX)) {
      try {
        const st = await fs.stat(abs);
        if (now - st.mtimeMs > staleThresholdMs) {
          await fs.unlink(abs).catch(() => undefined);
          out.bak_orphan_removed++;
        }
      } catch {
        // stat lỗi — bỏ qua
      }
      continue;
    }
  }

  return out;
}

/**
 * @deprecated 2026-07-06: dùng cleanupOrphanClipArtifacts.
 * Giữ signature cũ cho backward compat trong 1 vòng deploy.
 */
export async function cleanupOrphanConcatFiles(clipsDir: string): Promise<number> {
  const fs = await import("node:fs/promises");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(clipsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".concat.txt")) {
      await fs.unlink(path.join(clipsDir, e.name)).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}
