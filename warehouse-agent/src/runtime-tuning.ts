/**
 * Núm chỉnh NHẬN TỪ CLOUD lúc chạy (bản 0.13.0, kế hoạch VAN-HANH-NHIEU-KHO
 * đợt 7 — "nhận cấu hình từ cloud").
 *
 * Nguyên tắc 4.1: đổi một ngưỡng mà phải dựng bản agent mới rồi đi cài từng
 * máy là làm sai hướng. Cloud gửi `agent_config` trong phản hồi heartbeat;
 * agent áp ngay, không khởi động lại.
 *
 * Chỉ những núm AN TOÀN — độ ồn log. Không có núm nào đụng tới ghi hình,
 * cắt clip hay quét mã: cấu hình sai từ xa không được làm mất bằng chứng.
 * Giá trị lạ / ngoài khoảng bị bỏ qua, giữ giá trị đang dùng.
 */

export interface RuntimeTuning {
  /** Khoảng gom câu log lặp lại gửi lên cloud. */
  logRepeatWindowMs: number;
  /** Khoảng tóm tắt nhiễu giải mã của luồng đọc QR. */
  qrNoiseWindowMs: number;
}

export const TUNING_DEFAULTS: RuntimeTuning = {
  logRepeatWindowMs: 5 * 60_000,
  qrNoiseWindowMs: 5 * 60_000,
};

const BOUNDS_S = { min: 10, max: 3600 };

export const tuning: RuntimeTuning = { ...TUNING_DEFAULTS };

/**
 * Áp `agent_config` từ phản hồi heartbeat. Trả các khoá đã đổi (để log một
 * lần). Không ném.
 */
export function applyCloudTuning(raw: unknown, target: RuntimeTuning = tuning): string[] {
  if (!raw || typeof raw !== "object") return [];
  const src = raw as Record<string, unknown>;
  const changed: string[] = [];
  const set = (key: keyof RuntimeTuning, seconds: unknown) => {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return;
    if (seconds < BOUNDS_S.min || seconds > BOUNDS_S.max) return;
    const ms = Math.round(seconds) * 1000;
    if (target[key] !== ms) {
      target[key] = ms;
      changed.push(key);
    }
  };
  set("logRepeatWindowMs", src.log_repeat_window_seconds);
  set("qrNoiseWindowMs", src.qr_noise_window_seconds);
  return changed;
}
