/**
 * Bản tự khai của agent — định dạng, bóc, và các phép phán xét thuần
 * (kế hoạch VAN-HANH-NHIEU-KHO, đợt 7, phần 4.1).
 *
 * AGENT KHAI BÁO, CLOUD PHÁN XÉT: agent chỉ nói sự thật về mình; cái gì là
 * lỗi, ngưỡng bao nhiêu — quyết ở đây, trên cloud. Đổi ngưỡng không cần bản
 * agent mới.
 *
 * Agent gửi trong thân heartbeat: `{ ping, time_drift_seconds, self_report }`.
 * Agent bản cũ (≤ 0.12.x) không gửi `self_report` — cloud hiện "chưa khai".
 *
 * BÓC PHÒNG THỦ: thân heartbeat đến từ máy khách. Trường lạ bị bỏ, chuỗi bị
 * cắt, mảng bị giới hạn, số bị kẹp — một agent lỗi (hay bị sửa) không được
 * nhồi JSON tuỳ ý vào database hay làm vỡ trang Đội agent.
 *
 * Hàm thuần, không đụng DB.
 */

export const SELF_REPORT_VERSION = 1;

/**
 * Phiên bản agent mới nhất đã phát hành. Trang Đội agent đánh dấu máy nào
 * thấp hơn. Phát hành bản mới thì sửa ở đây — cùng lúc với RELEASES.md.
 */
export const LATEST_AGENT_VERSION = "0.14.0";

/**
 * Khả năng agent tự khai. Cloud bật tính năng theo KHẢ NĂNG, không theo so
 * sánh số phiên bản: bản nào khai thì bản đó có, không phải đoán.
 */
export const CAPABILITY = {
  /**
   * Bộ ghép clip tự hạ bitrate cho clip dài để vừa ngưỡng tải lên. Có khả
   * năng này cloud mới cho clip kiện hoàn dài tới 310s (kế hoạch 3.6) — agent
   * cũ nhận cửa sổ 310s sẽ ghép ra ~117 MiB rồi từ chối tải lên, mất trắng.
   */
  adaptiveClipBitrate: "adaptive_clip_bitrate",
  /** Nhận lệnh `collect_diagnostics`. */
  diagnostics: "collect_diagnostics",
} as const;

/**
 * Núm chỉnh gửi xuống agent trong phản hồi heartbeat (agent ≥ 0.13.0 áp
 * ngay, không khởi động lại — warehouse-agent/src/runtime-tuning.ts). Chỉ độ
 * ồn log; không núm nào đụng ghi hình, cắt clip, quét mã. Agent nhận 10–3600s.
 * Đổi ở đây là đổi cho mọi máy kho ở nhịp tim kế tiếp.
 */
export const AGENT_REMOTE_TUNING = {
  log_repeat_window_seconds: 300,
  qr_noise_window_seconds: 300,
} as const;

export interface SelfReportCamera {
  code: string;
  /** Tiến trình ghi của camera này đang chạy. */
  recording: boolean;
  /** Đoạn video gần nhất ghi xong lúc nào (ISO). */
  last_segment_at: string | null;
  /** Số lần giải mã khung hình hỏng trong giờ qua — nhiễu ffmpeg quy thành tỉ lệ. */
  bad_frames_last_hour: number | null;
}

export interface SelfReport {
  v: number;
  version: string;
  uptime_s: number | null;
  os: string | null;
  ffmpeg: string | null;
  cameras: SelfReportCamera[];
  disk: {
    free_bytes: number;
    total_bytes: number;
    /** Tốc độ ghi đầy trung bình, byte / ngày. null = chưa đủ số liệu. */
    bytes_per_day: number | null;
    /**
     * Thư mục ghi hình chiếm bao nhiêu byte — KHÁC `total - free` (toàn ổ, gồm
     * cả Windows và phần mềm khác). null = agent bản cũ, hoặc lượt này chưa đo.
     */
    recording_bytes: number | null;
  } | null;
  queues: {
    scans_pending: number | null;
    clips_pending: number | null;
    uploads_pending: number | null;
  };
  last_qr_success_at: string | null;
  /** Dấu vân tay cấu hình .env đang dùng — đổi là biết máy kho đã nhận cấu hình mới. */
  config_fingerprint: string | null;
  capabilities: string[];
}

const MAX_CAMERAS = 64;
const MAX_CAPABILITIES = 32;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

function num(v: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(v, max);
}

function iso(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Bóc `self_report` từ thân heartbeat. null = không có / không hợp lệ. */
export function parseSelfReport(raw: unknown): SelfReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const version = str(r.version, 32);
  // Không có phiên bản thì bản khai vô nghĩa — phiên bản là câu hỏi số một.
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) return null;

  const cameras: SelfReportCamera[] = Array.isArray(r.cameras)
    ? r.cameras.slice(0, MAX_CAMERAS).flatMap((c) => {
        if (!c || typeof c !== "object") return [];
        const cam = c as Record<string, unknown>;
        const code = str(cam.code, 64);
        if (!code) return [];
        return [
          {
            code,
            recording: cam.recording === true,
            last_segment_at: iso(cam.last_segment_at),
            bad_frames_last_hour: num(cam.bad_frames_last_hour, 10_000_000),
          },
        ];
      })
    : [];

  let disk: SelfReport["disk"] = null;
  if (r.disk && typeof r.disk === "object") {
    const d = r.disk as Record<string, unknown>;
    const free = num(d.free_bytes);
    const total = num(d.total_bytes);
    if (free !== null && total !== null && total > 0) {
      const rec = num(d.recording_bytes);
      disk = {
        free_bytes: Math.min(free, total),
        total_bytes: total,
        bytes_per_day: num(d.bytes_per_day),
        // Chặn trên bằng dung lượng ổ: thư mục không thể lớn hơn chính cái ổ
        // chứa nó. Số vượt trần là dấu hiệu đo sai, thà bó về trần còn hơn
        // hiện một con số vô lý.
        recording_bytes: rec === null ? null : Math.min(rec, total),
      };
    }
  }

  const q = (r.queues && typeof r.queues === "object" ? r.queues : {}) as Record<string, unknown>;

  return {
    v: SELF_REPORT_VERSION,
    version,
    uptime_s: num(r.uptime_s),
    os: str(r.os, 120),
    ffmpeg: str(r.ffmpeg, 120),
    cameras,
    disk,
    queues: {
      scans_pending: num(q.scans_pending, 1_000_000),
      clips_pending: num(q.clips_pending, 1_000_000),
      uploads_pending: num(q.uploads_pending, 1_000_000),
    },
    last_qr_success_at: iso(r.last_qr_success_at),
    config_fingerprint: str(r.config_fingerprint, 128),
    capabilities: Array.isArray(r.capabilities)
      ? [...new Set(r.capabilities.filter((c): c is string => typeof c === "string" && c.length <= 64))].slice(
          0,
          MAX_CAPABILITIES,
        )
      : [],
  };
}

/** So hai phiên bản "a.b.c". Âm: a < b. Phần hậu tố (-beta) bỏ qua. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function hasCapability(report: Pick<SelfReport, "capabilities"> | null | undefined, cap: string): boolean {
  return !!report && Array.isArray(report.capabilities) && report.capabilities.includes(cap);
}

/** Ổ còn mấy ngày ở tốc độ ghi hiện tại. null = chưa đủ số liệu để nói. */
export function diskDaysLeft(disk: SelfReport["disk"]): number | null {
  if (!disk || !disk.bytes_per_day || disk.bytes_per_day <= 0) return null;
  return Math.floor((disk.free_bytes / disk.bytes_per_day) * 10) / 10;
}
