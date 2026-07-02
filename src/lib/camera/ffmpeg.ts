import "server-only";
import { spawn } from "node:child_process";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { maskRtspUrl } from "./rtsp";

// All ffmpeg interaction lives here so credentials never appear in any
// other log path. Callers pass the RTSP URL (which contains a password);
// we mask it before logging and never echo it in error messages we send
// to the client.

// Process-level kill timeouts. EZVIZ cameras commonly take 5-15s for
// DESCRIBE/SETUP/PLAY on a slow LAN, and may stall briefly before
// emitting the first keyframe. Operators on tighter networks can
// shorten via CAMERA_TEST_TIMEOUT_SECONDS.
const DEFAULT_TEST_TIMEOUT_SECONDS = Number(
  process.env.CAMERA_TEST_TIMEOUT_SECONDS ?? 30,
);
const SNAPSHOT_TIMEOUT_MS = 30_000;
const RECORD_HEADROOM_MS = 35_000;

export type RtspTransport = "tcp" | "udp" | "auto";

export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

// Input-side flags shared by every ffmpeg invocation. We deliberately do
// NOT pass `-stimeout` or `-rw_timeout` here: both are rejected as
// "Option not found" by the modern gyan.dev ffmpeg 8.1 build the user
// is running. Socket IO timeout is delegated to the process-level kill
// in runProcess. -analyzeduration/-probesize stay because they shorten
// stream analysis and are accepted by every build we've seen.
export function rtspInputArgs(rtspUrl: string, transport: "tcp" | "udp"): string[] {
  return [
    "-rtsp_transport", transport,
    "-analyzeduration", "1000000",
    "-probesize", "32768",
    "-i", rtspUrl,
  ];
}

export function recordingDir(): string {
  // Resolve relative to project cwd. process.cwd() when running `next dev`
  // / `next start` is the project root, so this matches the documented
  // RECORDING_DIR=./recordings default.
  const raw = process.env.RECORDING_DIR || "./recordings";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

export interface FfmpegRunResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string; // tail only — we cap to avoid huge memory use
  timedOut: boolean;
  binaryMissing: boolean;
  durationMs: number;
}

interface RunOpts {
  bin: string;
  args: string[];
  timeoutMs: number;
  // RTSP URL passed in args, for masked logging only.
  rtspUrlForLog?: string;
  logTag: string;
}

function runProcess(opts: RunOpts): Promise<FfmpegRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let proc;
    try {
      // stdio: stdin=ignore, stdout=pipe, stderr=pipe. We MUST attach a
      // listener to stdout below — Windows pipe buffers are tiny (~4KB)
      // and an unread stdout will block ffmpeg's write() and effectively
      // hang the whole process. This is what was masquerading as a
      // "network timeout" earlier.
      proc = spawn(opts.bin, opts.args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return resolve({
        ok: false,
        exitCode: null,
        signal: null,
        stderr: String((err as Error).message ?? err),
        timedOut: false,
        binaryMissing: code === "ENOENT",
        durationMs: 0,
      });
    }

    let stderrBuf = "";
    const MAX_STDERR = 16_000;
    let timedOut = false;
    let binaryMissing = false;

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") binaryMissing = true;
      stderrBuf += String(err.message ?? err) + "\n";
    });
    // Drain stdout. We don't care about the bytes (ffmpeg muxer/null
    // output) but we MUST consume them so the OS pipe doesn't fill.
    proc.stdout?.on("data", () => {});
    proc.stdout?.on("error", () => {});
    // Diagnostic: also dump stderr live to the server console while we're
    // still tracking down why ffmpeg appears to hang. The chunk may
    // contain the RTSP URL, so we mask it before logging.
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (process.env.CAMERA_DEBUG_FFMPEG === "1") {
        const safe = opts.rtspUrlForLog
          ? text.split(opts.rtspUrlForLog).join(maskRtspUrl(opts.rtspUrlForLog))
          : text;
        process.stdout.write(`[ffmpeg:${opts.logTag}:live] ${safe}`);
      }
      if (stderrBuf.length < MAX_STDERR) {
        stderrBuf += text;
        if (stderrBuf.length > MAX_STDERR) {
          stderrBuf = stderrBuf.slice(-MAX_STDERR);
        }
      }
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      // First try the polite SIGTERM (lets ffmpeg flush mp4 trailer if
      // any), then SIGKILL the whole process tree 1s later. On Windows
      // child_process.kill maps to TerminateProcess; we also fire
      // taskkill /T to clean up any grand-children ffmpeg may have spawned.
      try {
        proc.kill("SIGTERM");
      } catch {
        // process may have already exited
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        if (process.platform === "win32" && proc.pid) {
          // Best-effort tree kill so a stuck ffmpeg can't leak.
          try {
            spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
          } catch {}
        }
      }, 1000);
    }, opts.timeoutMs);

    proc.on("close", (code, signal) => {
      clearTimeout(killTimer);
      const masked = opts.rtspUrlForLog ? maskRtspUrl(opts.rtspUrlForLog) : "";
      console.log(
        `[ffmpeg:${opts.logTag}] exit=${code} signal=${signal ?? "-"} ` +
          `timeout=${timedOut} url=${masked}`,
      );
      // When the process didn't exit cleanly, surface the stderr tail so
      // we can diagnose RTSP/codec errors. The URL is masked above already,
      // but the URL also appears inside ffmpeg's own stderr messages
      // (e.g. "Cannot open rtsp://admin:Pw@..."), so we mask the buffer too.
      if (!timedOut && code !== 0 && stderrBuf) {
        const safe = opts.rtspUrlForLog
          ? stderrBuf.split(opts.rtspUrlForLog).join(maskRtspUrl(opts.rtspUrlForLog))
          : stderrBuf;
        console.log(`[ffmpeg:${opts.logTag}] stderr:\n${safe}`);
      }
      resolve({
        ok: !timedOut && !binaryMissing && code === 0,
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        stderr: stderrBuf.trim(),
        timedOut,
        binaryMissing,
        durationMs: Date.now() - started,
      });
    });
  });
}

// Map raw ffmpeg/ffprobe stderr into a Vietnamese, user-facing message
// the dashboard can show. We intentionally do not expose the raw stderr
// (it would include the RTSP URL).
export function classifyFfmpegError(r: FfmpegRunResult): string {
  if (r.binaryMissing) {
    return "FFmpeg chưa được cài hoặc chưa cấu hình FFMPEG_PATH / FFPROBE_PATH.";
  }
  if (r.timedOut) {
    return "Camera phản hồi chậm hoặc FFmpeg không lấy được frame trong thời gian cho phép. Hãy thử tăng timeout hoặc kiểm tra Wi-Fi camera.";
  }
  const lower = r.stderr.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized")) {
    return "Sai tên đăng nhập hoặc mật khẩu camera.";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "Sai đường dẫn RTSP (rtsp_path). Kiểm tra lại path trên camera.";
  }
  if (
    lower.includes("connection refused") ||
    lower.includes("no route to host") ||
    lower.includes("network is unreachable") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "Không kết nối được tới camera. Sai IP / port hoặc camera không bật RTSP.";
  }
  if (lower.includes("invalid data") || lower.includes("could not find codec")) {
    return "Stream RTSP không hợp lệ. Có thể sai path hoặc camera trả về codec lạ.";
  }
  return "Không kết nối được camera. Kiểm tra IP, port, username, password, RTSP path.";
}

// A failure mode worth retrying on a different transport. We don't retry
// on 401/404 — those will just reproduce on UDP and waste 30s.
function isLikelyTransportIssue(r: FfmpegRunResult): boolean {
  if (r.binaryMissing) return false;
  const lower = r.stderr.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized")) return false;
  if (lower.includes("404") || lower.includes("not found")) return false;
  // Connect timeouts, "server returned X" without auth, or our own kill
  // are all things UDP might rescue.
  return true;
}

interface ProbeOptions {
  transport?: RtspTransport;
}

export async function testConnection(
  rtspUrl: string,
  options: ProbeOptions = {},
): Promise<FfmpegRunResult & { transport_used?: "tcp" | "udp" }> {
  // Snapshot-shaped probe: grab one frame, no audio, write to a temp
  // .jpg, delete on completion. Mirrors the snapshot path so a passing
  // test predicts snapshot/record will also pass.
  const timeoutMs = DEFAULT_TEST_TIMEOUT_SECONDS * 1000;

  const runOnce = async (transport: "tcp" | "udp") => {
    const dir = await ensureRecordingDir();
    const tmpFile = path.join(
      dir,
      `_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`,
    );
    const res = await runProcess({
      bin: ffmpegBin(),
      args: [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        ...rtspInputArgs(rtspUrl, transport),
        "-frames:v", "1",
        "-an",
        tmpFile,
      ],
      timeoutMs,
      rtspUrlForLog: rtspUrl,
      logTag: `probe:${transport}`,
    });
    void unlink(tmpFile).catch(() => {});
    return res;
  };

  const requested = options.transport ?? "auto";
  if (requested === "tcp" || requested === "udp") {
    const r = await runOnce(requested);
    return { ...r, transport_used: requested };
  }

  // auto: TCP first (more reliable on NAT/Wi-Fi), then UDP fallback.
  const first = await runOnce("tcp");
  if (first.ok) return { ...first, transport_used: "tcp" };
  if (!isLikelyTransportIssue(first)) return { ...first, transport_used: "tcp" };

  const second = await runOnce("udp");
  if (second.ok) return { ...second, transport_used: "udp" };
  // Both failed. Surface the attempt with the more useful stderr.
  const winner = second.stderr.length > first.stderr.length ? second : first;
  return { ...winner, transport_used: winner === second ? "udp" : "tcp" };
}

async function ensureRecordingDir(): Promise<string> {
  const dir = recordingDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

function timestampSuffix(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export interface RecordTestResult extends FfmpegRunResult {
  filePath?: string;
  fileName?: string;
  fileSizeBytes?: number;
}

export async function recordTest(
  rtspUrl: string,
  cameraCode: string,
  seconds = 10,
  options: ProbeOptions = {},
): Promise<RecordTestResult & { transport_used?: "tcp" | "udp" }> {
  const dir = await ensureRecordingDir();
  const safeCode = cameraCode.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safeCode}_test_${timestampSuffix()}.mp4`;
  const filePath = path.join(dir, fileName);

  // EZVIZ 10s record measured at ~15s wall-clock; RECORD_HEADROOM_MS
  // (35s) gives room for slow handshakes + mp4 trailer finalization.
  const timeoutMs = seconds * 1000 + RECORD_HEADROOM_MS;

  const runOnce = (transport: "tcp" | "udp") =>
    runProcess({
      bin: ffmpegBin(),
      args: [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-fflags", "+genpts",
        "-use_wallclock_as_timestamps", "1",
        ...rtspInputArgs(rtspUrl, transport),
        "-t", String(seconds),
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        filePath,
      ],
      timeoutMs,
      rtspUrlForLog: rtspUrl,
      logTag: `record:${transport}`,
    });

  const finalize = async (
    r: FfmpegRunResult,
    transport: "tcp" | "udp",
  ): Promise<RecordTestResult & { transport_used: "tcp" | "udp" }> => {
    if (!r.ok) return { ...r, transport_used: transport };
    try {
      const st = await stat(filePath);
      return { ...r, filePath, fileName, fileSizeBytes: st.size, transport_used: transport };
    } catch {
      return { ...r, filePath, fileName, transport_used: transport };
    }
  };

  const requested = options.transport ?? "auto";
  if (requested === "tcp" || requested === "udp") {
    return finalize(await runOnce(requested), requested);
  }

  const first = await runOnce("tcp");
  if (first.ok || !isLikelyTransportIssue(first)) return finalize(first, "tcp");
  // The first attempt may have left a partial file behind; clean it up
  // so the UDP retry starts fresh.
  void unlink(filePath).catch(() => {});
  const second = await runOnce("udp");
  if (second.ok) return finalize(second, "udp");
  // Pick the attempt with more diagnostic info.
  const winner = second.stderr.length > first.stderr.length ? second : first;
  return finalize(winner, winner === second ? "udp" : "tcp");
}

export async function snapshot(
  rtspUrl: string,
  cameraCode: string,
  options: ProbeOptions = {},
): Promise<{
  result: FfmpegRunResult;
  filePath?: string;
  fileName?: string;
  transport_used?: "tcp" | "udp";
}> {
  const dir = await ensureRecordingDir();
  const safeCode = cameraCode.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safeCode}_snapshot_${timestampSuffix()}.jpg`;
  const filePath = path.join(dir, fileName);
  const timeoutMs = SNAPSHOT_TIMEOUT_MS;

  const runOnce = (transport: "tcp" | "udp") =>
    runProcess({
      bin: ffmpegBin(),
      args: [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        ...rtspInputArgs(rtspUrl, transport),
        "-frames:v", "1",
        "-an",
        filePath,
      ],
      timeoutMs,
      rtspUrlForLog: rtspUrl,
      logTag: `snapshot:${transport}`,
    });

  const finalize = (r: FfmpegRunResult, transport: "tcp" | "udp") =>
    r.ok
      ? { result: r, filePath, fileName, transport_used: transport }
      : { result: r, transport_used: transport };

  const requested = options.transport ?? "auto";
  if (requested === "tcp" || requested === "udp") {
    return finalize(await runOnce(requested), requested);
  }

  const first = await runOnce("tcp");
  if (first.ok || !isLikelyTransportIssue(first)) return finalize(first, "tcp");
  void unlink(filePath).catch(() => {});
  const second = await runOnce("udp");
  if (second.ok) return finalize(second, "udp");
  const winner = second.stderr.length > first.stderr.length ? second : first;
  return finalize(winner, winner === second ? "udp" : "tcp");
}
