import "server-only";

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface UtcRange {
  startIso: string;
  endIso: string;
}

function rangeFromVnMidnightUtcMs(startVnUtcMs: number): UtcRange {
  return {
    startIso: new Date(startVnUtcMs).toISOString(),
    endIso: new Date(startVnUtcMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Returns the UTC range that corresponds to "today" in Asia/Ho_Chi_Minh
 * (UTC+7, no DST). The KPI queries use timestamptz columns, so we have
 * to pass real UTC instants — not naive Vietnam-local strings.
 */
export function vietnamTodayUtcRange(now: Date = new Date()): UtcRange {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  // Midnight in VN expressed in UTC ms.
  const startVnUtcMs =
    Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) -
    VN_OFFSET_MS;
  return rangeFromVnMidnightUtcMs(startVnUtcMs);
}

/** "YYYY-MM-DD" của hôm nay theo giờ VN — dùng làm giá trị mặc định. */
export function vietnamTodayKey(now: Date = new Date()): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${vn.getUTCFullYear()}-${pad(vn.getUTCMonth() + 1)}-${pad(vn.getUTCDate())}`;
}

/**
 * Khoảng UTC của MỘT ngày VN cho trước ("YYYY-MM-DD").
 *
 * Trả null nếu chuỗi sai định dạng HOẶC không phải ngày có thật
 * (2026-02-31 → Date.UTC tự cuộn sang 03-03, nên phải round-trip kiểm lại;
 * nếu không, người dùng gõ bậy sẽ nhận dữ liệu của một ngày khác mà
 * không hề biết).
 */
export interface DayScope extends UtcRange {
  dateKey: string;
  /** Client gửi ngày sai định dạng / không có thật → đã rơi về hôm nay. */
  invalidDate: boolean;
}

/**
 * Đọc query param `date` thành khoảng một ngày VN, mặc định hôm nay.
 *
 * Dùng chung cho mọi endpoint mà UI giám sát bó theo ngày — hai route
 * tự parse riêng là hai định nghĩa "ngày rác thì làm gì" chực lệch nhau.
 */
export function resolveVietnamDayScope(dateParam: string | null): DayScope {
  if (dateParam) {
    const range = vietnamDayUtcRange(dateParam);
    if (range) return { dateKey: dateParam, ...range, invalidDate: false };
    // Ngày rác: rơi về hôm nay và NÓI RA, không im lặng trả nhầm ngày.
    return { dateKey: vietnamTodayKey(), ...vietnamTodayUtcRange(), invalidDate: true };
  }
  return { dateKey: vietnamTodayKey(), ...vietnamTodayUtcRange(), invalidDate: false };
}

export function vietnamDayUtcRange(dateKey: string): UtcRange | null {
  if (!DATE_KEY_RE.test(dateKey)) return null;
  const [y, m, d] = dateKey.split("-").map((p) => Number.parseInt(p, 10));
  const vnMidnightMs = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(vnMidnightMs)) return null;
  const back = new Date(vnMidnightMs);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== m - 1 ||
    back.getUTCDate() !== d
  ) {
    return null;
  }
  return rangeFromVnMidnightUtcMs(vnMidnightMs - VN_OFFSET_MS);
}
