import "dotenv/config";
import { z } from "zod";

/**
 * Legacy / env-level fallback only. Pin a device_code to a literal COM
 * path when the scanner reports no usable identity (cheap USB-serial
 * chips with empty serial_number AND identical VID/PID across units).
 *
 * The normal pairing flow is the PairDialog in the dashboard — that
 * writes device_identity into station_devices and the agent rebinds
 * automatically through /api/warehouse/discovery. Pins are SKIPPED for
 * any device_code that already has device_identity stored in DB, so a
 * stale pin can't shadow an identity-driven binding.
 *
 * Prefer pairing by identity. Use this only when identity disambiguation
 * is impossible.
 */
const ScannerPinSchema = z.object({
  scanner_device_code: z.string().min(1),
  port: z.string().min(1),
  baudRate: z.number().int().positive().default(9600),
});

const EnvSchema = z.object({
  BACKEND_URL: z.string().url(),
  AGENT_CODE: z.string().min(1),
  AGENT_SECRET: z.string().min(8),
  /**
   * Optional manual pins, same shape as the legacy SCANNERS_JSON. When
   * empty the agent runs fully discovery-driven, binding scanners by
   * identity returned from /api/warehouse/discovery.
   */
  SCANNERS_JSON: z.string().optional().default("[]"),
  FLUSH_DEBOUNCE_MS: z.coerce.number().int().positive().default(120),
  RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RECONNECT_DELAY_MS: z.coerce.number().int().positive().default(5000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  DISCOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  DEFAULT_BAUD_RATE: z.coerce.number().int().positive().default(9600),
  /**
   * Interval agent short-poll cloud xem có job mới không
   * (POST /api/agent/poll-commands). 3s là mức đủ nhanh cho use case
   * điều khiển từ dashboard mà không tốn request vô ích.
   */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  /**
   * Interval TCP-connect probe RTSP port của mọi camera trong lifecycle,
   * batch report cloud (POST /api/agent/camera-probe). 30s = mỗi camera
   * cứ 30s được kiểm nghe port một lần; cam vừa off sẽ thấy Offline
   * trong 1-30s (agent report cả fail). 90s = 3 nhịp missed mới stale.
   */
  CAMERA_PROBE_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  /**
   * Thư mục lưu segment recording. Mỗi camera có thư mục riêng
   * <RECORDING_DIR>/<camera_code>/<YYYY>/<MM>/<DD>/<code>_<YYYYMMDD>_<HHMMSS>.mp4
   */
  RECORDING_DIR: z.string().min(1).default("./recordings"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  /**
   * Boot cần credential từ cloud (không lưu password local). Nếu mạng
   * kho chưa lên, agent retry lấy credential mỗi ngần này.
   */
  RECORDING_CREDENTIALS_RETRY_MS: z.coerce.number().int().positive().default(10000),
  /**
   * Boot recovery scan cửa sổ N ngày về trước để backfill segment file
   * trên đĩa mà cloud chưa biết (VD mạng đứt lâu → agent vẫn ghi vào
   * ổ, không report kịp lên cloud → boot sau bù). File cũ hơn N ngày
   * bị filter cứng ở `scanDirForMp4`.
   *
   * BĂNG CỨU THƯƠNG (v0.6.3, 2026-07-13): nâng từ 2 → 30. Đủ Tết + kho
   * nghỉ dài, chi phí scan boot chấp nhận được (30 ngày × 5 cam × 1440
   * file/day ≈ 216k stat calls, <5s).
   *
   * FIX GỐC (nợ Mốc 3): thay "scan N ngày cứng" bằng "scan từ mốc file
   * cuối cùng đã có trong DB". Số ngày cứng luôn có ca vượt (kho nghỉ
   * dài hơn N). Cần endpoint cloud trả `latest_file_mtime` per camera,
   * agent scan từ đó tới now. Xem cọc project_recovery_scan_gap.md.
   */
  RECOVERY_SCAN_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * fs.watch có thể miss event trên một số filesystem Windows
   * (SMB, virtualization). Poll fallback quét thư mục camera đang
   * ghi mỗi ngần này để bắt segment mới mà watcher bỏ sót.
   */
  SEGMENT_WATCH_POLL_MS: z.coerce.number().int().positive().default(10000),
  /**
   * Remote log push. Bật mặc định — Hạnh ở xa, cần log-từ-xa để chẩn
   * đoán. Có env off để test/dev tắt.
   */
  LOG_EVENTS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Chu kỳ flush batch log lên cloud (ms). 30s mặc định — cân bằng
   * tần suất request vs độ tươi log. ERROR flush ngay bỏ qua chu kỳ.
   */
  LOG_EVENTS_FLUSH_MS: z.coerce.number().int().positive().default(30000),
  // BURN_* env đã xoá 2026-07-05: đường clip chốt "video thuần" —
  // không burn (nướng vào file), không overlay (đè giao diện), không
  // vẽ mark gap. Thông tin đơn (mã vận đơn/kho/bàn/nhân viên/camera/
  // thời gian) hiện ở panel cạnh video trong dashboard.
});

export type ScannerPin = z.infer<typeof ScannerPinSchema>;

export interface AgentConfig {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  /** Manual COM pins; empty = fully identity-driven. */
  pinnedScanners: ScannerPin[];
  flushDebounceMs: number;
  retryIntervalMs: number;
  reconnectDelayMs: number;
  heartbeatIntervalMs: number;
  discoveryIntervalMs: number;
  defaultBaudRate: number;
  pollIntervalMs: number;
  cameraProbeIntervalMs: number;
  recordingDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  recordingCredentialsRetryMs: number;
  recoveryScanDays: number;
  segmentWatchPollMs: number;
  logEventsEnabled: boolean;
  logEventsFlushMs: number;
}

export function loadConfig(): AgentConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const env = parsed.data;

  let pinnedRaw: unknown = [];
  try {
    pinnedRaw = JSON.parse(env.SCANNERS_JSON);
  } catch (err) {
    throw new Error(
      `SCANNERS_JSON is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(pinnedRaw)) {
    throw new Error("SCANNERS_JSON must be a JSON array (or omit entirely)");
  }
  const pinnedScanners = z.array(ScannerPinSchema).parse(pinnedRaw);

  return {
    backendUrl: env.BACKEND_URL.replace(/\/+$/, ""),
    agentCode: env.AGENT_CODE,
    agentSecret: env.AGENT_SECRET,
    pinnedScanners,
    flushDebounceMs: env.FLUSH_DEBOUNCE_MS,
    retryIntervalMs: env.RETRY_INTERVAL_MS,
    reconnectDelayMs: env.RECONNECT_DELAY_MS,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    discoveryIntervalMs: env.DISCOVERY_INTERVAL_MS,
    defaultBaudRate: env.DEFAULT_BAUD_RATE,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    cameraProbeIntervalMs: env.CAMERA_PROBE_INTERVAL_MS,
    recordingDir: env.RECORDING_DIR,
    ffmpegPath: env.FFMPEG_PATH,
    ffprobePath: env.FFPROBE_PATH,
    recordingCredentialsRetryMs: env.RECORDING_CREDENTIALS_RETRY_MS,
    recoveryScanDays: env.RECOVERY_SCAN_DAYS,
    segmentWatchPollMs: env.SEGMENT_WATCH_POLL_MS,
    logEventsEnabled: env.LOG_EVENTS_ENABLED,
    logEventsFlushMs: env.LOG_EVENTS_FLUSH_MS,
  };
}
