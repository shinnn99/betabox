import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ComposeAngleInput {
  segments: string[];
  firstStartedAt: string;
}

export interface ComposeClipOptions {
  ffmpegBin: string;
  overview: ComposeAngleInput | null;
  qr: ComposeAngleInput | null;
  outputPath: string;
  targetStart: string;
  targetEnd: string;
  informationText?: string;
  fontPath?: string;
  timeoutMs?: number;
}

function quoteConcat(filePath: string): string {
  return `file '${filePath.replaceAll("'", "'\\''")}'`;
}

function escapeFilterValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll("%", "\\%");
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-12_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
    });
  });
}

function seekSeconds(targetStart: string, firstStartedAt: string): string {
  return String(
    Math.max(0, (Date.parse(targetStart) - Date.parse(firstStartedAt)) / 1000),
  );
}

/**
 * Render the same composition used by LiveLayout:
 * overview fills 16:9, QR occupies the top-right 1/9 area, and an
 * informational strip sits at the bottom. Inputs are first concatenated
 * without cutting; precise per-camera seeks happen while re-encoding.
 *
 * This function is request-driven only. Recording segments are kept as raw
 * camera files until the cloud asks for a proof clip, then the owning agent
 * composes the final evidence MP4 from the local segments it already has.
 */
export async function composeProofClip(options: ComposeClipOptions): Promise<void> {
  if (!options.overview && !options.qr) {
    throw new Error("at least one camera angle is required");
  }
  const durationSeconds = Math.max(
    0,
    (Date.parse(options.targetEnd) - Date.parse(options.targetStart)) / 1000,
  );
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("invalid compose target window");
  }

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const stamp = `${process.pid}-${Date.now()}`;
  const temporaryFiles: string[] = [];

  const joinAngle = async (
    role: "overview" | "qr",
    angle: ComposeAngleInput,
  ): Promise<string> => {
    if (angle.segments.length === 0) throw new Error(`${role} has no segments`);
    const listPath = `${options.outputPath}.${stamp}.${role}.txt`;
    const joinedPath = `${options.outputPath}.${stamp}.${role}.mp4`;
    temporaryFiles.push(listPath, joinedPath);
    await writeFile(
      listPath,
      angle.segments.map(quoteConcat).join("\n") + "\n",
      "utf8",
    );
    await run(
      options.ffmpegBin,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-map", "0:v:0", "-c", "copy", "-an",
        "-avoid_negative_ts", "make_zero", joinedPath,
      ],
      timeoutMs,
    );
    return joinedPath;
  };

  try {
    const [overviewJoined, qrJoined] = await Promise.all([
      options.overview ? joinAngle("overview", options.overview) : null,
      options.qr ? joinAngle("qr", options.qr) : null,
    ]);

    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    let overviewInput = -1;
    let qrInput = -1;
    let inputCount = 0;
    if (overviewJoined && options.overview) {
      args.push(
        "-ss", seekSeconds(options.targetStart, options.overview.firstStartedAt),
        "-i", overviewJoined,
      );
      overviewInput = inputCount++;
    }
    if (qrJoined && options.qr) {
      args.push(
        "-ss", seekSeconds(options.targetStart, options.qr.firstStartedAt),
        "-i", qrJoined,
      );
      qrInput = inputCount++;
    }

    const baseInput = overviewInput >= 0 ? overviewInput : qrInput;
    const filters = [
      `[${baseInput}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080[base]`,
    ];
    let composedLabel = "base";
    if (overviewInput >= 0 && qrInput >= 0) {
      filters.push(
        `[${qrInput}:v]scale=640:360:force_original_aspect_ratio=increase,crop=640:360[qr]`,
        "[base][qr]overlay=1280:0:eof_action=pass[pip]",
        "[pip]drawbox=x=1278:y=0:w=642:h=362:color=white@0.95:t=2[framed]",
      );
      composedLabel = "framed";
    }

    const missingAngleText = !options.overview
      ? "KHÔNG CÓ VIDEO GÓC TOÀN CẢNH"
      : !options.qr
        ? "KHÔNG CÓ VIDEO GÓC QUÉT MÃ"
        : "";
    filters.push(
      `[${composedLabel}]drawbox=x=0:y=900:w=1920:h=180:color=black@0.72:t=fill[strip]`,
    );
    composedLabel = "strip";

    const text = [options.informationText, missingAngleText]
      .filter(Boolean)
      .join("  ·  ");
    if (text && options.fontPath) {
      const font = escapeFilterValue(path.resolve(options.fontPath).replaceAll("\\", "/"));
      filters.push(
        `[strip]drawtext=fontfile='${font}':text='${escapeFilterValue(text)}':` +
          "fontcolor=white:fontsize=34:x=40:y=970[texted]",
      );
      composedLabel = "texted";
    }

    args.push(
      "-t", durationSeconds.toFixed(3),
      "-filter_complex", filters.join(";"),
      "-map", `[${composedLabel}]`,
      "-an", "-c:v", "libx264", "-preset", "veryfast",
      "-b:v", "3200k", "-maxrate", "4500k", "-bufsize", "9000k",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      options.outputPath,
    );
    await run(options.ffmpegBin, args, timeoutMs);
  } finally {
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => undefined)));
  }
}
