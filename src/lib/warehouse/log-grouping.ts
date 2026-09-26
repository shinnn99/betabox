/**
 * Gom log agent ở cloud (kế hoạch VAN-HANH-NHIEU-KHO, đợt 8).
 *
 * Đo 7 ngày ở một kho: 26.990 dòng `agent_log_events`, 77% nhiễu. Agent
 * 0.13.0 đã tự gom câu lặp ở nguồn, nhưng máy kho chạy bản cũ vẫn xả như
 * trước — và năm mươi kho không lên bản mới cùng một ngày. Nên cloud gom
 * lại: cùng máy, cùng mức, cùng câu (đã bỏ số / hex / id), cùng khung giờ →
 * MỘT dòng, `repeat_count` tăng dần (hàm `ingest_agent_log_events`, migration
 * 20260926150000).
 *
 * Khung: 60 phút cho warn, 30 phút cho error — lỗi thật lặp lại vẫn hiện
 * mỗi nửa giờ một dòng, không chìm cả giờ trong một dòng.
 *
 * Hàm thuần — test được không cần database.
 */

export type LogLevel = "warn" | "error";

export const LOG_BUCKET_MINUTES: Record<LogLevel, number> = { warn: 60, error: 30 };

/**
 * Khoá so trùng — BẢN SAO của `noiseKey` bên agent
 * (`warehouse-agent/src/log-noise.ts`). Hai bên phải ra cùng khoá, để dòng
 * tóm tắt "(lặp lại N lần…)" của agent mới rơi đúng vào nhóm của câu gốc.
 */
export function logDedupeKey(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Tiền tố dòng tóm tắt agent 0.13.0 gửi khi hết khoảng gom ở nguồn. */
const REPEAT_SUMMARY = /^\(lặp lại (\d+) lần trong \d+ phút\) /;

/**
 * "(lặp lại 40 lần trong 10 phút) câu mẫu" → 40 lần, "câu mẫu". Câu thường →
 * 1 lần, giữ nguyên.
 */
export function parseRepeatSummary(message: string): { count: number; message: string } {
  const m = message.match(REPEAT_SUMMARY);
  if (!m) return { count: 1, message };
  const n = Number(m[1]);
  const rest = message.slice(m[0].length);
  if (!Number.isSafeInteger(n) || n < 1 || rest.length === 0) return { count: 1, message };
  return { count: n, message: rest };
}

/** Đầu khung gom (giờ UTC tròn khung — giờ Việt Nam lệch tròn giờ nên khớp). */
export function logBucketStart(level: LogLevel, emittedAtMs: number): string {
  const size = LOG_BUCKET_MINUTES[level] * 60_000;
  return new Date(Math.floor(emittedAtMs / size) * size).toISOString();
}

export interface LogEventInput {
  level: LogLevel;
  message: string;
  emittedAtMs: number;
}

/** Một phần tử gửi cho `ingest_agent_log_events`. */
export interface GroupedLogEvent {
  level: LogLevel;
  message: string;
  emitted_at: string;
  last_emitted_at: string;
  dedupe_key: string;
  bucket_start: string;
  count: number;
}

/**
 * Gom một lô: cùng (mức, khung, khoá) → một phần tử. Câu mẫu là câu SỚM NHẤT
 * trong lô; hàm SQL giữ câu của dòng đã có nếu khung đã có dòng. Thứ tự ra
 * theo lần đầu xuất hiện trong lô.
 */
export function groupLogEvents(events: readonly LogEventInput[]): GroupedLogEvent[] {
  const groups = new Map<
    string,
    { level: LogLevel; message: string; key: string; bucket: string; firstMs: number; lastMs: number; count: number }
  >();
  for (const e of events) {
    const { count, message } = parseRepeatSummary(e.message);
    const key = logDedupeKey(message);
    const bucket = logBucketStart(e.level, e.emittedAtMs);
    const id = `${e.level}|${bucket}|${key}`;
    const g = groups.get(id);
    if (!g) {
      groups.set(id, { level: e.level, message, key, bucket, firstMs: e.emittedAtMs, lastMs: e.emittedAtMs, count });
      continue;
    }
    g.count += count;
    if (e.emittedAtMs < g.firstMs) {
      g.firstMs = e.emittedAtMs;
      g.message = message;
    }
    if (e.emittedAtMs > g.lastMs) g.lastMs = e.emittedAtMs;
  }
  return [...groups.values()].map((g) => ({
    level: g.level,
    message: g.message,
    emitted_at: new Date(g.firstMs).toISOString(),
    last_emitted_at: new Date(g.lastMs).toISOString(),
    dedupe_key: g.key,
    bucket_start: g.bucket,
    count: g.count,
  }));
}

/** Tổng số lần một câu đã xảy ra — dòng trước migration không có cột → 1. */
export function logOccurrences(row: { repeat_count?: number | null }): number {
  const n = row.repeat_count;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? n : 1;
}
