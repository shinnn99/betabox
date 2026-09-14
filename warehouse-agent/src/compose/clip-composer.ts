import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";

export interface ComposeClipOptions {
  ffmpegBin: string;
  overviewSegments: string[];
  qrSegments: string[];
  outputPath: string;
  seekSeconds?: number;
  durationSeconds?: number;
}

function quoteConcat(path: string): string { return `file '${path.replaceAll("'", "'\\''")}'`; }

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8_000); });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)));
  });
}

export async function composeProofClip(options: ComposeClipOptions): Promise<void> {
  if (!options.overviewSegments.length || !options.qrSegments.length) throw new Error("both camera angles are required");
  const stamp = `${process.pid}-${Date.now()}`;
  const overviewList = `${options.outputPath}.${stamp}.overview.txt`;
  const qrList = `${options.outputPath}.${stamp}.qr.txt`;
  const overviewJoined = `${options.outputPath}.${stamp}.overview.mp4`;
  const qrJoined = `${options.outputPath}.${stamp}.qr.mp4`;
  try {
    await Promise.all([
      writeFile(overviewList, options.overviewSegments.map(quoteConcat).join("\n") + "\n", "utf8"),
      writeFile(qrList, options.qrSegments.map(quoteConcat).join("\n") + "\n", "utf8"),
    ]);
    await Promise.all([
      run(options.ffmpegBin, ["-y", "-f", "concat", "-safe", "0", "-i", overviewList, "-c", "copy", overviewJoined]),
      run(options.ffmpegBin, ["-y", "-f", "concat", "-safe", "0", "-i", qrList, "-c", "copy", qrJoined]),
    ]);
    const seek = String(Math.max(0, options.seekSeconds ?? 0));
    const args = ["-y", "-ss", seek, "-i", overviewJoined, "-ss", seek, "-i", qrJoined];
    if (options.durationSeconds) args.push("-t", String(options.durationSeconds));
    args.push("-filter_complex", "[1:v]scale=640:360[qr];[0:v][qr]overlay=1280:0[v]", "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", options.outputPath);
    await run(options.ffmpegBin, args);
  } finally {
    await Promise.all([overviewList, qrList, overviewJoined, qrJoined].map(path => unlink(path).catch(() => undefined)));
  }
}
