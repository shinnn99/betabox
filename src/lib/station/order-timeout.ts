/**
 * Trần thời gian đóng MỘT đơn tại bàn đóng hàng.
 *
 * Vì sao cần tầng này: `process_waybill_scan` chỉ chốt đơn đang mở KHI
 * có mã kế tiếp được quét. Nếu nhân viên bỏ dở (đi ăn, quên quét mã
 * mới), đơn treo `timing_status='open'` vô thời hạn và cửa sổ clip kéo
 * dài theo. Nghiệp vụ yêu cầu: quá `max_order_seconds` là cưỡng chế
 * dừng, không chờ mã kế.
 *
 * Trần cứng 180s KHÔNG phải con số nghiệp vụ tuỳ ý — nó khớp với
 * `MAX_CLIP_DURATION_SECONDS` ở `src/lib/order-proof/clip-window.ts`.
 * Clip proof không bao giờ dài hơn 180s, nên để đơn mở lâu hơn thế chỉ
 * tạo ra khoảng thời gian không có bằng chứng video tương ứng. Nếu sau
 * này nới trần clip thì sửa CẢ HAI chỗ, đừng nới một bên.
 */

/** Trần cứng — phải bằng `MAX_CLIP_DURATION_SECONDS` của clip-window. */
export const ORDER_HARD_LIMIT_SECONDS = 180;

/** Sàn phòng thủ khi config kho ghi nhầm đơn vị (VD 3 thay vì 180). */
export const ORDER_MIN_LIMIT_SECONDS = 30;

/** Còn bao nhiêu giây thì màn hình bàn đọc cảnh báo sắp hết giờ. */
export const ORDER_WARNING_LEAD_SECONDS = 30;

/** Ghi vào `packing_events.timing_note` để phân biệt với capped_timeout do quét mã kế. */
export const AUTO_STOP_TIMING_NOTE = "auto_stopped_timeout";

/**
 * Giới hạn thực tế = `max_order_seconds` của kho, kẹp trong
 * [ORDER_MIN_LIMIT_SECONDS, ORDER_HARD_LIMIT_SECONDS].
 *
 * Kho cấu hình 600s (Đại Kim) vẫn bị kéo về 180s ở tầng này: 600s là
 * ngưỡng NGHIỆP VỤ để đánh dấu đơn bất thường, còn đây là ngưỡng KỸ
 * THUẬT của video. Hai khái niệm khác nhau (xem ghi chú hai lớp ở
 * clip-resolver.ts), nhưng video thì không thể vượt 180s.
 */
export function resolveOrderLimitSeconds(cfg: unknown): number {
  const fallback = ORDER_HARD_LIMIT_SECONDS;
  if (!cfg || typeof cfg !== "object") return fallback;
  const raw = Number((cfg as Record<string, unknown>).max_order_seconds);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(
    ORDER_HARD_LIMIT_SECONDS,
    Math.max(ORDER_MIN_LIMIT_SECONDS, Math.floor(raw)),
  );
}

/**
 * Trần thời gian MỘT kiện hoàn (chốt với chủ dự án 18/09/2026: 5 phút).
 *
 * Khác đơn đi ở chỗ đây là thời gian MỞ HÀNG và kiểm, không phải năng suất
 * đóng gói. Quá hạn thì kiện tự đóng với kết quả "chưa kiểm" và vẫn sinh hồ
 * sơ — không kiện nào treo, không kiện nào mất bằng chứng.
 */
export const RETURN_HARD_LIMIT_SECONDS = 300;

/** Sàn phòng thủ khi config kho ghi nhầm đơn vị. */
export const RETURN_MIN_LIMIT_SECONDS = 60;

/** Trần cho kiện hoàn = `return_max_seconds` của kho, kẹp trong khoảng an toàn. */
export function resolveReturnLimitSeconds(cfg: unknown): number {
  const fallback = RETURN_HARD_LIMIT_SECONDS;
  if (!cfg || typeof cfg !== "object") return fallback;
  const raw = Number((cfg as Record<string, unknown>).return_max_seconds);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(RETURN_MIN_LIMIT_SECONDS, Math.floor(raw));
}

/** Trần đúng theo loại lượt: đơn đi hay kiện hoàn. */
export function resolveLimitSecondsFor(
  eventKind: string | null | undefined,
  cfg: unknown,
): number {
  return eventKind === "return"
    ? resolveReturnLimitSeconds(cfg)
    : resolveOrderLimitSeconds(cfg);
}

export interface OrderTimeoutState {
  /** Mốc bị cưỡng chế dừng. */
  deadlineAt: Date;
  /** Số giây còn lại, đã kẹp về >= 0. */
  remainingSeconds: number;
  /** Đã quá hạn — phải chốt đơn. */
  expired: boolean;
  /** Sắp hết giờ — màn hình bàn đọc cảnh báo một lần. */
  warning: boolean;
}

/**
 * Tính trạng thái đếm ngược của một đơn đang mở.
 *
 * `startedAt` dùng `work_started_at` (RPC set = scanned_at). Nếu row cũ
 * thiếu cột đó thì caller truyền `scanned_at`.
 */
export function computeOrderTimeout(input: {
  startedAt: Date | string;
  limitSeconds: number;
  now?: Date;
}): OrderTimeoutState {
  const startedMs = new Date(input.startedAt).getTime();
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.floor(input.limitSeconds));

  // Row hỏng (started_at không parse được) → coi như hết hạn ngay để
  // không có đơn nào treo mãi mà không ai phát hiện.
  if (!Number.isFinite(startedMs)) {
    return {
      deadlineAt: now,
      remainingSeconds: 0,
      expired: true,
      warning: false,
    };
  }

  const deadlineMs = startedMs + limit * 1000;
  const remainingSeconds = Math.max(
    0,
    Math.ceil((deadlineMs - now.getTime()) / 1000),
  );
  const expired = now.getTime() >= deadlineMs;
  return {
    deadlineAt: new Date(deadlineMs),
    remainingSeconds,
    expired,
    warning: !expired && remainingSeconds <= ORDER_WARNING_LEAD_SECONDS,
  };
}
