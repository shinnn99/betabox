import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * BLOCKS-GO-LIVE (nhắc lại rõ ràng, không tự thăng cấp thành "đã đóng"):
 *
 * Idempotent-guard `startupSet + runningMap` bên dưới CHỈ atomic trong
 * MỘT Node process. Nếu chạy 2 agent cùng lúc (2 máy kho, hoặc lỡ 2
 * instance trên 1 máy), mỗi process có Set/Map riêng — cả hai đều thấy
 * "camera X chưa được ghi" và cùng spawn ffmpeg → 2 ffmpeg cùng ghi
 * 1 camera. Đó chính là bug ta hứa diệt.
 *
 * Hàng rào duy nhất còn lại là partial unique index
 *   idx_one_active_recording_per_camera (camera_recording_sessions)
 * — index này chặn 2 session 'recording' cùng camera_id ở tầng DB.
 * NHƯNG nó chỉ cứu được nếu cả hai agent đi qua backend TẠO/VERIFY
 * session TRƯỚC KHI spawn ffmpeg. Nếu agent spawn ffmpeg trước rồi
 * mới báo, ffmpeg thứ hai đã chạy rồi trước khi DB kịp từ chối.
 *
 * Ca multi-agent CHƯA được chặn hoàn chỉnh. Chặn thật cần:
 *   (a) Producer phía backend enqueueStartRecording từ chối nếu đã có
 *       camera_recording_sessions.status='recording' của agent khác
 *       cho camera này. Đây là tuyến chặn ở cloud.
 *   (b) Agent hỏi backend "tôi có được phép ghi camera này không" ngay
 *       trước spawn, không dựa RAM cục bộ. Round-trip đắt hơn.
 * Chưa làm ở Lát 2 vì hiện tại chỉ có một agent test. Trước khi vận
 * hành >1 agent, xử lý (a) là tối thiểu bắt buộc.
 */

export interface RecordingSpec {
  cameraId: string;
  cameraCode: string;
  sessionId: string;
  rtspUrl: string;
  transport: "tcp" | "udp";
  segmentSeconds: number;
}

export interface RunningRecording {
  spec: RecordingSpec;
  child: ChildProcess;
  pid: number;
  startedAt: Date;
  lastStderr: string;
}

const runningMap = new Map<string, RunningRecording>();
const startupSet = new Set<string>();

export function isRecording(cameraId: string): boolean {
  return runningMap.has(cameraId) || startupSet.has(cameraId);
}

export function getRecording(cameraId: string): RunningRecording | undefined {
  return runningMap.get(cameraId);
}

export function listActiveRecordings(): RunningRecording[] {
  return Array.from(runningMap.values());
}

function maskRtspUrl(url: string): string {
  return url.replace(/(rtsp:\/\/[^:/@]+:)([^@]+)(@)/i, "$1***$3");
}

function safeCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function cameraRecordingDir(root: string, cameraCode: string): string {
  return path.join(root, safeCode(cameraCode));
}

// BLOCKS-GO-LIVE (Lát 3a-2 + Lát 5): clip bằng chứng sẽ được đặt tại
// `<RECORDING_DIR>/_clips/<packing_event_id>.mp4` bởi 3a-2. Prefix
// `_clips` (underscore) cố ý khác với format thư mục camera code để
// dễ loại trừ. Job cleanup segment (Lát 5) PHẢI LOẠI TRỪ `_clips`
// khỏi phạm vi quét xóa — clip bằng chứng có vòng đời khác segment
// (giữ lâu hơn). Nếu ai làm cleanup mà không loại trừ, clip bằng
// chứng sẽ bị xóa nhầm sau retention window của segment.
export const CLIPS_SUBDIR = "_clips";

function segmentPattern(root: string, cameraCode: string): string {
  const code = safeCode(cameraCode);
  return path.join(
    cameraRecordingDir(root, code),
    "%Y",
    "%m",
    "%d",
    `${code}_%Y%m%d_%H%M%S.mp4`,
  );
}

async function ensureTodayDir(root: string, cameraCode: string): Promise<void> {
  const base = cameraRecordingDir(root, cameraCode);
  await fs.mkdir(base, { recursive: true });
  const today = new Date();
  const dated = path.join(
    base,
    String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  );
  await fs.mkdir(dated, { recursive: true });
}

export interface StartOutcome {
  ok: true;
  pid: number;
  outputDir: string;
  // 3b-2 followup: kết quả probe codec (nếu chạy). Null nếu chưa probe.
  codecDetected: string | null;
  codecWarning: string | null;
}

export interface StartFailed {
  ok: false;
  reason: string;
  stderrTail: string;
}

export interface StartArgs {
  ffmpegBin: string;
  ffprobeBin: string;  // 3b-2 followup: cho probeCodec
  recordingRoot: string;
  spec: RecordingSpec;
  earlyExitWatchdogMs: number;
  onUnexpectedExit: (info: {
    spec: RecordingSpec;
    code: number | null;
    signal: NodeJS.Signals | null;
    lastStderr: string;
  }) => void;
}

/**
 * Spawn ffmpeg cho một camera. Idempotent theo cameraId trong CÙNG
 * process (xem BLOCKS-GO-LIVE ở đầu file cho ca multi-agent).
 *
 * Chờ earlyExitWatchdogMs (mặc định 3s ở caller) rồi mới báo done:
 *   - ffmpeg sống qua watchdog → { ok: true, pid, outputDir }
 *   - ffmpeg exit trong watchdog → { ok: false, reason, stderrTail }
 *
 * onUnexpectedExit CHỈ được gọi khi ffmpeg exit SAU watchdog (nghĩa là
 * recording đã ổn định rồi mới chết) — dùng để trigger respawn logic
 * bên ngoài. Nếu exit trong watchdog, coi là start failed, không gọi
 * onUnexpectedExit.
 */
export async function startRecording(args: StartArgs): Promise<StartOutcome | StartFailed> {
  const cid = args.spec.cameraId;

  // Idempotent guard — kiểm TRƯỚC spawn. Node single-thread nên hai
  // handleCommand đồng thời không thể cùng vượt qua bước này.
  if (runningMap.has(cid) || startupSet.has(cid)) {
    return { ok: false, reason: "already_recording", stderrTail: "" };
  }
  startupSet.add(cid);

  try {
    await ensureTodayDir(args.recordingRoot, args.spec.cameraCode);

    // 3b-2 followup: probe codec camera trước spawn recording.
    // Best-effort — probe fail thì codec_detected=null, VẪN spawn.
    // Await probe exit dứt điểm + breathing 50ms cho OS TCP cleanup
    // trước khi mở connection mới cho recording (camera-giới-hạn-
    // connection không thấy chồng).
    const probeResult = await probeCodec(
      args.ffprobeBin,
      args.spec.rtspUrl,
      args.spec.transport,
    );
    if (probeResult.ok) {
      console.log(
        `[recording] probe camera=${args.spec.cameraCode} codec=${probeResult.codec}${probeResult.codecWarning ? ` warning=${probeResult.codecWarning}` : ""}`,
      );
    } else {
      console.warn(
        `[recording] probe FAILED camera=${args.spec.cameraCode} reason=${probeResult.reason} — proceeding with recording, codec unknown`,
      );
    }
    await new Promise((r) => setTimeout(r, PROBE_RECORDING_HANDOFF_MS));

    const pattern = segmentPattern(args.recordingRoot, args.spec.cameraCode);
    // Timeout kết nối RTSP. Đặt SAU -rtsp_transport, TRƯỚC -i, vì đây
    // là option của RTSP demuxer (không phải global). Đơn vị microseconds.
    // ffmpeg 8.1 gyan.dev từ chối -rw_timeout global (Option not found),
    // và -stimeout đã deprecated → dùng -timeout của RTSP demuxer.
    //
    // Vì sao cần: không đặt timeout → ffmpeg stall vô hạn khi host chết
    // (không route, IP fake), watchdog agent không cứu được vì process
    // vẫn "sống" trong lúc chờ TCP timeout của OS. 15s đủ cho camera
    // chậm bình thường, đủ ngắn để fail fast khi host thật sự chết.
    const rtspTimeoutUs = String(15 * 1000 * 1000);
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "warning",
      "-rtsp_transport", args.spec.transport,
      "-timeout", rtspTimeoutUs,
      "-analyzeduration", "5000000",
      "-probesize", "5000000",
      "-i", args.spec.rtspUrl,
      "-c:v", "copy",
      "-bsf:v", "dump_extra",
      "-an",
      "-video_track_timescale", "90000",
      "-max_muxing_queue_size", "1024",
      "-avoid_negative_ts", "make_zero",
      "-f", "segment",
      "-segment_time", String(args.spec.segmentSeconds),
      "-segment_format", "mp4",
      "-reset_timestamps", "1",
      "-strftime", "1",
      pattern,
    ];

    let child: ChildProcess;
    try {
      child = spawn(args.ffmpegBin, ffmpegArgs, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `spawn_error: ${(err as Error).message}`,
        stderrTail: "",
      };
    }

    if (!child.pid) {
      return { ok: false, reason: "spawn_no_pid", stderrTail: "" };
    }

    let lastStderr = "";
    const STDERR_TAIL = 8_000;
    let exitedEarly = false;
    let earlyExitCode: number | null = null;
    let earlyExitSignal: NodeJS.Signals | null = null;

    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const safe = text.split(args.spec.rtspUrl).join(maskRtspUrl(args.spec.rtspUrl));
      lastStderr = (lastStderr + safe).slice(-STDERR_TAIL);
      process.stdout.write(`[recording:${args.spec.cameraCode}] ${safe}`);
    });

    let watchdogDone = false;
    child.on("exit", (code, signal) => {
      if (!watchdogDone) {
        exitedEarly = true;
        earlyExitCode = code;
        earlyExitSignal = signal as NodeJS.Signals | null;
        return;
      }
      // Exit SAU watchdog — recording đã ổn định rồi mới chết. Snapshot
      // stderr trước khi drop entry.
      const entry = runningMap.get(cid);
      if (entry) entry.lastStderr = lastStderr;
      runningMap.delete(cid);
      console.log(
        `[recording] exit camera=${args.spec.cameraCode} pid=${child.pid} code=${code} signal=${signal ?? "-"}`,
      );
      args.onUnexpectedExit({
        spec: args.spec,
        code,
        signal: signal as NodeJS.Signals | null,
        lastStderr,
      });
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      lastStderr = (lastStderr + `\nspawn error: ${err.code ?? ""} ${err.message ?? err}`).slice(-STDERR_TAIL);
    });

    // Watchdog: đợi earlyExitWatchdogMs. Nếu ffmpeg exit trong khoảng
    // này → coi start failed.
    await new Promise<void>((r) => setTimeout(r, args.earlyExitWatchdogMs));
    watchdogDone = true;

    if (exitedEarly) {
      return {
        ok: false,
        reason: `early_exit code=${earlyExitCode} signal=${earlyExitSignal ?? "-"}`,
        stderrTail: lastStderr,
      };
    }

    const entry: RunningRecording = {
      spec: args.spec,
      child,
      pid: child.pid,
      startedAt: new Date(),
      lastStderr: "",
    };
    runningMap.set(cid, entry);

    const outputDir = cameraRecordingDir(args.recordingRoot, args.spec.cameraCode);
    console.log(
      `[recording] start camera=${args.spec.cameraCode} pid=${child.pid} segment=${args.spec.segmentSeconds}s transport=${args.spec.transport} url=${maskRtspUrl(args.spec.rtspUrl)}`,
    );
    return {
      ok: true,
      pid: child.pid,
      outputDir,
      codecDetected: probeResult.ok ? probeResult.codec : null,
      codecWarning: probeResult.ok ? probeResult.codecWarning : null,
    };
  } finally {
    startupSet.delete(cid);
  }
}

export interface StopOutcome {
  stopped: boolean;
  forced: boolean;
}

export async function stopRecording(cameraId: string, graceMs = 3000): Promise<StopOutcome> {
  const entry = runningMap.get(cameraId);
  if (!entry) return { stopped: false, forced: false };
  const { child, pid } = entry;

  try {
    child.stdin?.write("q\n");
    child.stdin?.end();
  } catch {
    // stdin closed already
  }

  const startWait = Date.now();
  while (runningMap.has(cameraId) && Date.now() - startWait < graceMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!runningMap.has(cameraId)) return { stopped: true, forced: false };

  try {
    child.kill("SIGTERM");
  } catch {}
  const startTerm = Date.now();
  while (runningMap.has(cameraId) && Date.now() - startTerm < 1500) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!runningMap.has(cameraId)) return { stopped: true, forced: false };

  try {
    child.kill("SIGKILL");
  } catch {}
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
  }
  const startForce = Date.now();
  while (runningMap.has(cameraId) && Date.now() - startForce < 2000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { stopped: !runningMap.has(cameraId), forced: true };
}

// BLOCKS-GO-LIVE (3b-2 followup — HEVC-not-blocked):
// probeCodec CHỈ CẢNH BÁO khi camera phát non-h264. KHÔNG TỪ CHỐI
// spawn recording (mất data). Với HEVC, clip/live view trên web sẽ
// tịt — 3c là chỗ quyết ép H.264 tuyệt đối hay chấp nhận HEVC +
// transcode ở xem. Cam_02 HEVC hiện tại là quả mìn đã biết, giữ để
// test mỗi tầng phát hiện xuyên loạt.
//
// Probe là BEST-EFFORT: fail → codec_detected=null, VẪN spawn
// recording bình thường. Đừng để việc phụ (detection) giết việc
// chính (ghi hình).
//
// Camera giới hạn connection concurrent (một số cam 1-2 max): probe
// mở connection → đóng dứt điểm → await 50ms cho OS TCP cleanup →
// RỒI spawn recording. Không chồng connection.
export interface CodecProbeResult {
  ok: boolean;
  codec: string | null;   // 'h264', 'hevc', 'mpeg4', ... hoặc null nếu fail
  codecWarning: string | null;  // 'not_browser_safe' khi codec ≠ h264, null khi codec=h264 hoặc probe fail
  reason: string | null;  // lý do fail (timeout/connect error/parse error)
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_TO_RECORDING_BREATHING_MS = 50;

export async function probeCodec(
  ffprobeBin: string,
  rtspUrl: string,
  transport: "tcp" | "udp",
): Promise<CodecProbeResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        ffprobeBin,
        [
          "-v", "error",
          "-rtsp_transport", transport,
          "-analyzeduration", "3000000",
          "-probesize", "3000000",
          "-select_streams", "v:0",
          "-show_entries", "stream=codec_name",
          "-of", "default=noprint_wrappers=1:nokey=1",
          rtspUrl,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      return resolve({
        ok: false,
        codec: null,
        codecWarning: null,
        reason: `spawn_error: ${(err as Error).message}`,
      });
    }
    let out = "";
    let errBuf = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      errBuf += c.toString("utf8");
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });
    const t = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, PROBE_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(t);
      resolve({
        ok: false,
        codec: null,
        codecWarning: null,
        reason: `proc_error: ${err.message}`,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) {
        return resolve({
          ok: false,
          codec: null,
          codecWarning: null,
          reason: `exit_${code}: ${errBuf.trim().slice(-200)}`,
        });
      }
      const codec = out.trim().toLowerCase();
      if (!codec) {
        return resolve({
          ok: false,
          codec: null,
          codecWarning: null,
          reason: "empty_output",
        });
      }
      const warning = codec === "h264" ? null : "not_browser_safe";
      resolve({ ok: true, codec, codecWarning: warning, reason: null });
    });
  });
}

// ---------- Lát 2 SaaS: test camera connection từ agent ----------
//
// Web Vercel không tới được camera LAN → test-connection phải chạy ở
// agent. Agent nhận command `test_camera_connection` → gọi hàm này →
// report done/failed qua reportCommandResult.
//
// Hàm này ngắn hơn probeCodec: không phân tích codec, chỉ verify RTSP
// alive + credential đúng. Grab 1 frame với ffmpeg (ghi tmp rồi xóa)
// tương tự pattern web cũ.

export interface TestConnectionResult {
  ok: boolean;
  durationMs: number;
  transportUsed: "tcp" | "udp";
  reason: string | null;
}

const TEST_CONNECTION_TIMEOUT_MS = 10_000;

export async function testCameraConnection(
  ffmpegBin: string,
  rtspUrl: string,
  transport: "tcp" | "udp",
): Promise<TestConnectionResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Ghi tmp frame vào ổ tạm agent, xóa ngay sau khi ffmpeg exit.
    // Tên file random tránh collision khi nhiều test song song.
    const tmpFile = path.join(
      tmpdir(),
      `_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`,
    );
    let proc;
    try {
      proc = spawn(
        ffmpegBin,
        [
          "-hide_banner",
          "-loglevel", "error",
          "-y",
          "-rtsp_transport", transport,
          "-i", rtspUrl,
          "-frames:v", "1",
          "-an",
          tmpFile,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      return resolve({
        ok: false,
        durationMs: Date.now() - started,
        transportUsed: transport,
        reason: `spawn_error: ${(err as Error).message}`,
      });
    }
    let errBuf = "";
    proc.stderr?.on("data", (c: Buffer) => {
      errBuf += c.toString("utf8");
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });
    const t = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, TEST_CONNECTION_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(t);
      resolve({
        ok: false,
        durationMs: Date.now() - started,
        transportUsed: transport,
        reason: `proc_error: ${err.message}`,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      // Xóa tmp best-effort
      fs.unlink(tmpFile).catch(() => {});
      if (code !== 0) {
        return resolve({
          ok: false,
          durationMs: Date.now() - started,
          transportUsed: transport,
          reason: `exit_${code}: ${errBuf.trim().slice(-200)}`,
        });
      }
      resolve({
        ok: true,
        durationMs: Date.now() - started,
        transportUsed: transport,
        reason: null,
      });
    });
  });
}

/**
 * Delay giữa probe exit và spawn recording. Cho OS cleanup TCP FIN
 * handshake để camera-giới-hạn-connection không thấy 2 connection
 * chồng lên nhau trong milli-giây chuyển giao.
 */
export const PROBE_RECORDING_HANDOFF_MS = PROBE_TO_RECORDING_BREATHING_MS;

// Phân loại lỗi tạm/vĩnh viễn từ stderr — dùng cho retry policy.
// Vĩnh viễn: không retry, xóa desired. Tạm thời: retry ngắn + long-retry.
export type ErrorKind = "transient" | "permanent";

export function classifyErrorFromStderr(stderr: string): ErrorKind {
  const lower = stderr.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("404") ||
    lower.includes("not found") ||
    lower.includes("invalid data") ||
    lower.includes("could not find codec")
  ) {
    return "permanent";
  }
  // Default: transient (mạng, host chết tạm, ffmpeg tự exit lạ...).
  // Đây là chỗ mà ta cố ý nghiêng về "giữ desired" — kho rớt mạng
  // đâu đó phải tự ghi lại khi mạng về, không thể coi mặc định là
  // vĩnh viễn.
  return "transient";
}
