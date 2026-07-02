import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ffmpegBin } from "./ffmpeg";
import { maskRtspUrl } from "./rtsp";
import { cameraRecordingDir, segmentPattern } from "./recording-paths";

// In-memory map of active recording processes. We stash it on
// globalThis so Next.js dev-mode HMR reloads of *this* module (or any
// module that imports it) do NOT lose the map. Without this, every
// HMR cycle creates a fresh empty Map, the status route concludes
// "process not found", marks the session as error, and the next user
// Start spawns a duplicate ffmpeg — producing the 4-second-segment
// avalanche we saw in the wild.
//
// The map is still lost on a real Node process restart, which is fine:
// the boot sweep in instrumentation.ts marks orphan sessions as error.
interface RunningRecording {
  sessionId: string;
  cameraId: string;
  cameraCode: string;
  pid: number;
  startedAt: Date;
  child: ChildProcess;
  // Last line of ffmpeg stderr, masked. Used by /status for diagnostics.
  lastStderr: string;
}

type Holder = { map: Map<string, RunningRecording> };
const GLOBAL_KEY = "__beta_cam_recording_map__";
function getRunningMap(): Map<string, RunningRecording> {
  const g = globalThis as unknown as Record<string, Holder | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { map: new Map() };
  }
  return g[GLOBAL_KEY]!.map;
}
const running = getRunningMap();

export function isRecording(cameraId: string): boolean {
  return running.has(cameraId);
}

export function getRecording(cameraId: string): RunningRecording | undefined {
  return running.get(cameraId);
}

export function listRunningCameraIds(): string[] {
  return Array.from(running.keys());
}

export interface StartParams {
  sessionId: string;
  cameraId: string;
  cameraCode: string;
  rtspUrl: string;
  transport: "tcp" | "udp";
  segmentSeconds: number;
  // Called when the ffmpeg process exits (clean or error). The caller
  // is responsible for updating the DB row — we don't touch Supabase
  // from here to keep this module deterministic and easy to test.
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; lastStderr: string }) => void;
}

export interface StartResult {
  pid: number;
  outputDir: string;
}

// Start a long-running ffmpeg that writes 60s segments via -f segment.
// Does NOT block waiting for ffmpeg to exit — that's the whole point.
export async function startRecording(p: StartParams): Promise<StartResult> {
  if (running.has(p.cameraId)) {
    throw new Error("already_recording");
  }

  const outputDir = cameraRecordingDir(p.cameraCode);
  await mkdir(outputDir, { recursive: true });

  // ffmpeg's segment muxer does NOT mkdir intermediate directories for
  // the strftime pattern (%Y/%m/%d). Pre-create today's path so the
  // first segment can be opened on Windows where directory autocreate
  // is unreliable across ffmpeg builds.
  const today = new Date();
  const datePath = path.join(
    outputDir,
    String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  );
  await mkdir(datePath, { recursive: true });

  const pattern = segmentPattern(p.cameraCode);
  // Bump verbosity so any failure (auth, codec, segment open) ends up
  // in stderr instead of being silently dropped by `-loglevel error`.
  const logLevel = process.env.CAMERA_DEBUG_FFMPEG === "1" ? "verbose" : "warning";
  // EZVIZ H1c emits RTP timestamps with such a large timescale that
  // mp4 muxer's 32-bit signed `duration` field overflows
  // ("Packet duration ... out of range / pts has no value"), and the
  // default probesize (32k) is too small to detect framerate before
  // the first output is opened. Fix:
  //   * Override RTSP input args here — we need bigger probesize for
  //     long-running record specifically, not the short-lived probe.
  //   * `-video_track_timescale 90000` forces mp4 to use the standard
  //     H264 RTP timescale instead of whatever the camera advertises.
  //   * `-bsf:v dump_extra` keeps SPS/PPS in front of every keyframe so
  //     each segment is independently playable.
  // We deliberately do NOT set `-use_wallclock_as_timestamps 1` or
  // `-fflags +genpts` — both broke `-c copy` in earlier attempts.
  const args = [
    "-hide_banner",
    "-loglevel", logLevel,
    "-rtsp_transport", p.transport,
    "-analyzeduration", "5000000",
    "-probesize", "5000000",
    "-i", p.rtspUrl,
    "-c:v", "copy",
    "-bsf:v", "dump_extra",
    "-an",
    "-video_track_timescale", "90000",
    "-max_muxing_queue_size", "1024",
    "-avoid_negative_ts", "make_zero",
    "-f", "segment",
    "-segment_time", String(p.segmentSeconds),
    "-segment_format", "mp4",
    // NOTE: we tried fragmented MP4 (movflags=+frag_keyframe+empty_moov)
    // to make killed-mid-write segments still playable. EZVIZ's RTP
    // timestamps don't satisfy fragmented MP4's strict PTS contract,
    // so the muxer rejected packets ("Timestamps are unset",
    // "Non-monotonic DTS"). We accept the trade-off: regular MP4
    // means the segment currently being written needs a clean
    // shutdown to be playable. Any segment that already rolled is
    // fine. Stop endpoint sends SIGTERM (not SIGKILL) first so
    // ffmpeg has 3s to flush the moov trailer.
    "-reset_timestamps", "1",
    "-strftime", "1",
    pattern,
  ];

  const child = spawn(ffmpegBin(), args, {
    windowsHide: true,
    // stdin open as pipe: required to send the "q" quit command on
    // graceful stop. Windows has no real SIGTERM — sending it via
    // child.kill() maps to TerminateProcess, which kills the moov
    // trailer write and corrupts the current segment. Writing "q\n"
    // to stdin lets ffmpeg flush cleanly so the partial segment is
    // still playable.
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  // Drain stdout so the OS pipe never fills up. The segment muxer is
  // chatty on stderr but mostly silent on stdout; we still consume it.
  child.stdout?.on("data", () => {});

  let lastStderr = "";
  const STDERR_TAIL = 8_000;
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const safe = text.split(p.rtspUrl).join(maskRtspUrl(p.rtspUrl));
    lastStderr = (lastStderr + safe).slice(-STDERR_TAIL);
    // Always echo to server console — recording is a long-lived
    // background task so silent failures are painful to diagnose.
    // Lines are already password-masked.
    process.stdout.write(`[recording:${p.cameraCode}] ${safe}`);
  });

  if (!child.pid) {
    throw new Error("spawn_failed");
  }

  const entry: RunningRecording = {
    sessionId: p.sessionId,
    cameraId: p.cameraId,
    cameraCode: p.cameraCode,
    pid: child.pid,
    startedAt: new Date(),
    child,
    lastStderr: "",
  };
  running.set(p.cameraId, entry);

  console.log(
    `[recording] start camera=${p.cameraCode} pid=${child.pid} ` +
      `segment=${p.segmentSeconds}s transport=${p.transport} ` +
      `url=${maskRtspUrl(p.rtspUrl)}`,
  );

  child.on("error", (err: NodeJS.ErrnoException) => {
    lastStderr = (lastStderr + `\nspawn error: ${err.code ?? ""} ${err.message ?? err}`).slice(-STDERR_TAIL);
  });

  child.on("exit", (code, signal) => {
    // Snapshot stderr before we drop the entry so onExit gets the tail.
    const finalEntry = running.get(p.cameraId);
    if (finalEntry) finalEntry.lastStderr = lastStderr;
    running.delete(p.cameraId);
    console.log(
      `[recording] exit camera=${p.cameraCode} pid=${child.pid} ` +
        `code=${code} signal=${signal ?? "-"}`,
    );
    p.onExit({ code, signal: signal as NodeJS.Signals | null, lastStderr });
  });

  return { pid: child.pid, outputDir };
}

export interface StopResult {
  stopped: boolean;
  forced: boolean;
}

// Polite SIGTERM, then SIGKILL + Windows taskkill /T /F if it doesn't
// exit within `graceMs`. Returns once we believe the process is gone
// (we don't await the OS — exit handler fires asynchronously).
export async function stopRecording(
  cameraId: string,
  graceMs = 3000,
): Promise<StopResult> {
  const entry = running.get(cameraId);
  if (!entry) return { stopped: false, forced: false };

  const pid = entry.pid;
  // Polite quit: write "q\n" to ffmpeg's stdin so it flushes the mp4
  // moov trailer before exiting. On Unix this could also be SIGINT,
  // but Windows has no real signals — stdin "q" is the portable path.
  try {
    entry.child.stdin?.write("q\n");
    entry.child.stdin?.end();
  } catch {
    // stdin already closed; fall through to SIGTERM/taskkill
  }

  // Wait grace period for the exit listener to clean the Map.
  const start = Date.now();
  while (running.has(cameraId) && Date.now() - start < graceMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!running.has(cameraId)) {
    return { stopped: true, forced: false };
  }

  // ffmpeg ignored the quit command — escalate.
  try {
    entry.child.kill("SIGTERM");
  } catch {
    // already exited
  }
  const startTerm = Date.now();
  while (running.has(cameraId) && Date.now() - startTerm < 1500) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!running.has(cameraId)) {
    return { stopped: true, forced: false };
  }

  // Still alive — escalate.
  try {
    entry.child.kill("SIGKILL");
  } catch {}
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
  }

  // Give the OS another short window.
  const start2 = Date.now();
  while (running.has(cameraId) && Date.now() - start2 < 2000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { stopped: !running.has(cameraId), forced: true };
}

// Check whether the child process for a given session is still alive
// according to `kill -0` (signal 0). Used by lazy /status.
export function isAlive(cameraId: string): boolean {
  const entry = running.get(cameraId);
  if (!entry) return false;
  try {
    return entry.child.kill(0);
  } catch {
    return false;
  }
}
