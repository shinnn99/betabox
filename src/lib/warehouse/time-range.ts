import "server-only";

/**
 * Returns the UTC range that corresponds to "today" in Asia/Ho_Chi_Minh
 * (UTC+7, no DST). The KPI queries use timestamptz columns, so we have
 * to pass real UTC instants — not naive Vietnam-local strings.
 */
export function vietnamTodayUtcRange(now: Date = new Date()): {
  startIso: string;
  endIso: string;
} {
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const nowVnMs = now.getTime() + VN_OFFSET_MS;
  const vn = new Date(nowVnMs);
  // Midnight in VN expressed in UTC ms.
  const startVnUtcMs = Date.UTC(
    vn.getUTCFullYear(),
    vn.getUTCMonth(),
    vn.getUTCDate(),
  ) - VN_OFFSET_MS;
  const endVnUtcMs = startVnUtcMs + 24 * 60 * 60 * 1000;
  return {
    startIso: new Date(startVnUtcMs).toISOString(),
    endIso: new Date(endVnUtcMs).toISOString(),
  };
}
