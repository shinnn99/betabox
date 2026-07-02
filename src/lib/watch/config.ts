import "server-only";

/**
 * Cấu hình 3c watch clip pipeline.
 *
 * Anh có thể override qua .env.local:
 *   BUCKET_TTL_HOURS=72                # clip nằm bucket bao lâu trước khi cleanup xóa
 *   SIGNED_URL_TTL_SECONDS=2700        # hạn signed URL cấp cho browser (45 phút)
 *   UPLOAD_FAILED_COOLDOWN_MINUTES=10  # sau upload fail, đợi bao lâu mới auto-retry
 *   CRON_SECRET=<random-string>        # secret cho endpoint cleanup dùng bởi Vercel Cron
 *
 * KHÔNG lẫn BUCKET_TTL_HOURS (clip trên bucket bao lâu) và
 * SIGNED_URL_TTL_SECONDS (URL hạn bao lâu). Hai số độc lập:
 *   - TTL bucket dài (72h) — trong đó xem lại không cần re-upload.
 *   - URL hạn ngắn (45 phút) — chống rò rỉ URL, cấp URL mới mỗi call
 *     reconcile khi ready.
 */
export const BUCKET_NAME = "proof-clips-transient";

export const BUCKET_TTL_HOURS = Number(process.env.BUCKET_TTL_HOURS ?? 72);

export const SIGNED_URL_TTL_SECONDS = Number(
  process.env.SIGNED_URL_TTL_SECONDS ?? 2700,
);

export const UPLOAD_FAILED_COOLDOWN_MINUTES = Number(
  process.env.UPLOAD_FAILED_COOLDOWN_MINUTES ?? 10,
);

/**
 * 3d: ngưỡng agent offline. Đọc từ `warehouse_agents.last_seen_at`,
 * so với `now()`. Nếu chênh > ngưỡng này = agent offline.
 *
 * 30s = 10 poll interval (agent poll 3s). Không 15s để tránh nhấp
 * nháy khi agent hiccup mạng ngắn. Config để chỉnh theo mạng kho thật.
 */
export const AGENT_OFFLINE_THRESHOLD_SECONDS = Number(
  process.env.AGENT_OFFLINE_THRESHOLD_SECONDS ?? 30,
);

/**
 * 3d: nhịp poll giãn khi state=warehouse_offline. Không 2s vì offline
 * mất phút/giờ, poll 2s phí request + pin điện thoại.
 */
export const OFFLINE_POLL_INTERVAL_SECONDS = Number(
  process.env.OFFLINE_POLL_INTERVAL_SECONDS ?? 20,
);

/**
 * 3d: trần chờ trước khi báo giveup. Đo "kho đã offline bao lâu THẬT"
 * (từ last_seen_at), KHÔNG "tab này chờ bao lâu". Vì cùng phép tính
 * server đang làm để tính is_offline — chỉ trả thêm số, KHÔNG state
 * server mới. Client BỎ tracking offline start time — chỉ hiển thị +
 * dừng khi server nói giveup.
 *
 * Để test ca 5 (mở tab muộn khi kho đã offline lâu), hạ tạm xuống 1
 * phút: OFFLINE_POLL_GIVEUP_MINUTES=1. Rồi đặt lại 10.
 */
export const OFFLINE_POLL_GIVEUP_MINUTES = Number(
  process.env.OFFLINE_POLL_GIVEUP_MINUTES ?? 10,
);

/**
 * Path trong bucket cho clip của một packing_event.
 * <org_id>/<packing_event_id>.mp4 — org_id ở đầu để RLS policy tương
 * lai (nếu siết) có thể filter theo prefix.
 */
export function bucketPathFor(orgId: string, packingEventId: string): string {
  return `${orgId}/${packingEventId}.mp4`;
}
