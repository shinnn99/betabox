import "server-only";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { ffmpegBin } from "@/lib/camera/ffmpeg";
import type { SegmentFile } from "./clip-resolver";

// With cutMode='copy' ffmpeg must seek to the nearest keyframe at or
// before -ss; on a typical 2-4s GOP this can swallow up to one GOP plus
// a junction frame at segment boundaries. We pad the cut window so the
// keyframe-snap never eats into the business window. The trade-off is
// a slightly larger mp4; for proof clips that's preferable to "missing
// the moment". A reencode retry runs only if drift is still too large.
export const GOP_PAD_BEFORE_SECONDS = 3;
export const GOP_PAD_AFTER_SECONDS = 3;
// If actual duration is less than (targetDuration - this many seconds),
// callers should retry with cutMode='reencode'. Picked larger than a
// single GOP (≤4s) so a normal keyframe snap doesn't trigger a retry.
export const REENCODE_RETRY_DRIFT_SECONDS = 2;

// ffmpeg concat demuxer expects a text file with absolute paths. We
// generate it next to the output mp4 and remove it on completion.
export interface CutInput {
  files: SegmentFile[];
  // Business window — the audit timeline operators care about.
  // `cut*` (below) extend this by GOP buffers so `-c copy` never trims
  // away the moments inside the target window.
  targetStart: Date;
  targetEnd: Date;
  // Actual ffmpeg seek range. With cutMode='copy' this is wider than
  // [targetStart, targetEnd] by GOP_PAD_BEFORE/AFTER seconds; with
  // 'reencode' it's frame-accurate and equals the target window.
  cutStart: Date;
  cutEnd: Date;
  outputPath: string;
  cutMode: "copy" | "reencode";
  timeoutMs?: number;
}

export interface CutResult {
  ok: boolean;
  errorMessage?: string;
  // Duration of the produced mp4 as reported by ffprobe. Falls back to
  // the requested cut window length if ffprobe can't read the file.
  durationSeconds: number;
  // Length of the business window [targetStart, targetEnd]. This is the
  // number the dashboard should headline — "đơn này được quay 33s".
  targetDurationSeconds: number;
  // Length of the cut window [cutStart, cutEnd] — i.e. what we asked
  // ffmpeg for. With 'copy' this includes the GOP buffer.
  cutDurationSeconds: number;
  // True when ffprobe couldn't read the mp4 and we fell back to the
  // requested duration. Callers should log this and persist a warning so
  // ops know the duration shown to users is an estimate.
  durationProbeFailed: boolean;
  sizeBytes: number;
  stderrTail?: string;
}

// Build concat list. Each entry references one segment file. We do NOT
// trim per-file here — instead we let ffmpeg seek into the *concatenated*
// virtual stream with -ss/-to relative to the first file's start_at.
function buildConcatList(files: SegmentFile[]): string {
  return (
    files
      .map((f) => `file '${f.file_path.replace(/'/g, "'\\''")}'`)
      .join("\n") + "\n"
  );
}

export async function cutClip(input: CutInput): Promise<CutResult> {
  const outDir = path.dirname(input.outputPath);
  await mkdir(outDir, { recursive: true });

  const listPath = `${input.outputPath}.concat.txt`;
  await writeFile(listPath, buildConcatList(input.files), "utf8");

  // Offsets relative to the first segment's start. ffmpeg's concat
  // demuxer treats the joined timeline as one continuous stream
  // starting at 0, so we shift by (cutStart - file0.started_at).
  const firstStart = new Date(input.files[0].started_at).getTime();
  const ssSeconds = Math.max(
    0,
    (input.cutStart.getTime() - firstStart) / 1000,
  );
  const toSeconds = (input.cutEnd.getTime() - firstStart) / 1000;

  const args: string[] = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
  ];
  // -ss after -i is slower but accurate to keyframes; with -c copy it
  // still seeks at keyframe boundaries which is fine for proof clips.
  if (ssSeconds > 0) args.push("-ss", ssSeconds.toFixed(3));
  // Use -t (duration) instead of -to (absolute stop timestamp): when
  // combined with -ss, some ffmpeg builds interpret -to relative to the
  // seek point and some relative to the input timeline. -t avoids the
  // ambiguity entirely.
  const tSeconds = Math.max(0, toSeconds - ssSeconds);
  args.push("-t", tSeconds.toFixed(3));

  if (input.cutMode === "reencode") {
    // Re-encode to H.264 baseline for max browser compatibility (Chrome/
    // Edge/Firefox don't decode HEVC in <video> on Windows). Costs CPU;
    // only used when caller asks for it OR when the auto-detector finds
    // a HEVC source.
    args.push(
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "veryfast",
      "-crf", "23",
      "-an",
      "-movflags", "+faststart",
    );
  } else {
    args.push(
      "-c", "copy",
      "-bsf:v", "dump_extra",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "+faststart",
    );
  }
  args.push(input.outputPath);

  const timeoutMs = input.timeoutMs ?? 60_000;
  const stderrTail = await new Promise<string>((resolve) => {
    const proc = spawn(ffmpegBin(), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const cap = 8_000;
    proc.stdout?.on("data", () => {});
    proc.stderr?.on("data", (chunk: Buffer) => {
      buf = (buf + chunk.toString("utf8")).slice(-cap);
    });
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    proc.on("close", () => {
      clearTimeout(t);
      resolve(buf.trim());
    });
    proc.on("error", (err) => {
      buf += `\nspawn error: ${err.message}`;
    });
  });

  void unlink(listPath).catch(() => {});

  let size = 0;
  try {
    const st = await stat(input.outputPath);
    size = st.size;
  } catch {
    // file not created — failure
  }

  const targetDurationSeconds = Math.max(
    0,
    Math.round((input.targetEnd.getTime() - input.targetStart.getTime()) / 1000),
  );
  const cutDurationSeconds = Math.max(
    0,
    Math.round((input.cutEnd.getTime() - input.cutStart.getTime()) / 1000),
  );

  if (size <= 0) {
    return {
      ok: false,
      errorMessage:
        "Không tạo được file clip. " +
        (stderrTail ? "Chi tiết: " + stderrTail.split("\n").slice(-3).join(" | ") : ""),
      durationSeconds: 0,
      targetDurationSeconds,
      cutDurationSeconds,
      durationProbeFailed: false,
      sizeBytes: 0,
      stderrTail,
    };
  }

  // Read the actual duration from the produced mp4 so the DB row matches
  // what the user will see when they play the clip. If ffprobe fails we
  // fall back to the requested cut window length: the file is valid (we
  // just streamed it from concat + copy), so failing the whole generate
  // over a missing duration would be a worse UX than a slightly-off
  // number. The caller logs durationProbeFailed and stamps it into the
  // audit payload so ops can find affected clips.
  const probed = await probeDurationSeconds(input.outputPath);
  const durationProbeFailed = probed === null;
  const durationSeconds = probed ?? cutDurationSeconds;

  return {
    ok: true,
    durationSeconds,
    targetDurationSeconds,
    cutDurationSeconds,
    durationProbeFailed,
    sizeBytes: size,
    stderrTail,
  };
}

function ffprobeBin(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

// Codecs that <video> reliably plays across Chrome/Edge/Firefox on
// Windows without extra OS extensions. Anything else triggers an auto
// reencode to H.264 so operators don't see a black-frame clip.
const BROWSER_SAFE_VIDEO_CODECS = new Set([
  "h264",
  "avc1",
  "vp8",
  "vp9",
  "av1",
]);

export function isBrowserSafeVideoCodec(codec: string | null): boolean {
  if (!codec) return false;
  return BROWSER_SAFE_VIDEO_CODECS.has(codec.toLowerCase());
}

export interface ProbedCodec {
  // Lower-cased video codec name from ffprobe (e.g. "h264", "hevc"), or
  // null when ffprobe couldn't read the file.
  codec: string | null;
  // True only when ffprobe returned a parseable video stream. Distinguishes
  // "probe failed" from "no video stream found".
  probed: boolean;
}

export async function probeVideoCodec(filePath: string): Promise<ProbedCodec> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        ffprobeBin(),
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=codec_name",
          "-of", "default=noprint_wrappers=1:nokey=1",
          filePath,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      return resolve({ codec: null, probed: false });
    }
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    proc.stderr?.on("data", () => {});
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 10_000);
    proc.on("error", () => {
      clearTimeout(t);
      resolve({ codec: null, probed: false });
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return resolve({ codec: null, probed: false });
      const name = out.trim().toLowerCase();
      if (!name) return resolve({ codec: null, probed: true });
      resolve({ codec: name, probed: true });
    });
  });
}

async function probeDurationSeconds(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        ffprobeBin(),
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
      } catch {}
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
      resolve(Math.round(n));
    });
  });
}

export function _elapsedDescriptor(startedMs: number): string {
  return `${((Date.now() - startedMs) / 1000).toFixed(1)}s`;
}
