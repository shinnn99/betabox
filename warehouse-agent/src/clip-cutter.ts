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
 * Dọn `.concat.txt` orphan lúc boot — nếu agent crash giữa cắt clip,
 * file .concat.txt có thể còn sót trong _clips. Rẻ, gọi từ boot.
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
