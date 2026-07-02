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
   * BLOCKS-GO-LIVE: giả định agent không offline quá số ngày này. Kho
   * tắt máy cuối tuần / lễ dài → segment ngoài window không được
   * boot recovery backfill. Nới trước go-live nếu vận hành có kiểu
   * tắt máy dài.
   */
  RECOVERY_SCAN_DAYS: z.coerce.number().int().positive().default(2),
  /**
   * fs.watch có thể miss event trên một số filesystem Windows
   * (SMB, virtualization). Poll fallback quét thư mục camera đang
   * ghi mỗi ngần này để bắt segment mới mà watcher bỏ sót.
   */
  SEGMENT_WATCH_POLL_MS: z.coerce.number().int().positive().default(10000),
  /**
   * 3b-1: burn-in mã vận đơn + timestamp lên clip. Vị trí và style
   * cấu hình được để chuyển camera khác không phải sửa code.
   *
   * VERIFY-ON-HIKVISION: mặc định top-right tránh đè overlay bottom-left
   * của EZVIZ H1c test. Khi đổi Hikvision (overlay khác vị trí), kiểm
   * lại và đổi qua env nếu cần.
   */
  BURN_POSITION: z.enum(["top-right", "top-left", "bottom-right", "bottom-left"]).default("top-right"),
  BURN_FONT_SIZE_RATIO: z.coerce.number().positive().default(0.035),
  BURN_FONT_COLOR: z.string().default("white"),
  BURN_BORDER_COLOR: z.string().default("black"),
  BURN_BORDER_WIDTH: z.coerce.number().int().nonnegative().default(3),
  BURN_WARNING_COLOR: z.string().default("#ff3838"),
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
  recordingDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  recordingCredentialsRetryMs: number;
  recoveryScanDays: number;
  segmentWatchPollMs: number;
  burnPosition: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  burnFontSizeRatio: number;
  burnFontColor: string;
  burnBorderColor: string;
  burnBorderWidth: number;
  burnWarningColor: string;
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
    recordingDir: env.RECORDING_DIR,
    ffmpegPath: env.FFMPEG_PATH,
    ffprobePath: env.FFPROBE_PATH,
    recordingCredentialsRetryMs: env.RECORDING_CREDENTIALS_RETRY_MS,
    recoveryScanDays: env.RECOVERY_SCAN_DAYS,
    segmentWatchPollMs: env.SEGMENT_WATCH_POLL_MS,
    burnPosition: env.BURN_POSITION,
    burnFontSizeRatio: env.BURN_FONT_SIZE_RATIO,
    burnFontColor: env.BURN_FONT_COLOR,
    burnBorderColor: env.BURN_BORDER_COLOR,
    burnBorderWidth: env.BURN_BORDER_WIDTH,
    burnWarningColor: env.BURN_WARNING_COLOR,
  };
}
