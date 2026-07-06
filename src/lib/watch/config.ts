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
 * Reconcile /watch enqueue cooldown cho cut_clip.
 *
 * Bối cảnh (2026-07-03): rà DB cho một pe_id thấy 32 command `done` +
 * 0 row `order_proof_clips` trong 10 phút — /watch dội cut_clip vì
 * agent skip idempotent (không insert row) và `hasActiveJob` chỉ check
 * pending/taken, bỏ qua done. Vòng lặp: done + không row ready →
 * enqueue → agent skipped → done + không row ready → enqueue …
 *
 * Cooldown chặn ĐỘI ở mọi đường (không chỉ ca skipped đã fix ở agent).
 * Nếu vừa enqueue một cut_clip trong X giây qua BẤT KỂ STATUS (pending/
 * taken/done/failed) → không enqueue nữa, chờ.
 *
 * Đo theo `created_at` command gần nhất (không theo completed_at) để
 * command đang taken cũng nằm trong cửa sổ — không enqueue chồng.
 *
 * 60s = 1.5× thực tế (~40s cho happy path: cut ~34s + upload ~2s +
 * report ~500ms). Dư an toàn cho mạng chậm/agent bận.
 */
export const ENQUEUE_CUT_COOLDOWN_SECONDS = Number(
  process.env.ENQUEUE_CUT_COOLDOWN_SECONDS ?? 60,
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
 * Path bucket cho clip.
 *
 * Cấu trúc mới (safe-retry 2026-07-06): `{org}/{pe}/{clip_id}.mp4`.
 * Mỗi generation có clip_id riêng nên retry upload không đè object cũ →
 * clip cũ còn nguyên trên bucket cho tới khi cron TTL dọn (72h).
 *
 * Cấu trúc cũ `{org}/{pe}.mp4` vẫn hoạt động vì code đọc `bucket_path`
 * từ DB, không tự dựng lại — coexistence. KHÔNG tự tính path để LOOKUP.
 * Chỉ dùng hàm này khi TẠO clip mới (enqueue/upload/verify path mới).
 */
export function bucketPathFor(
  orgId: string,
  packingEventId: string,
  clipId: string,
): string {
  return `${orgId}/${packingEventId}/${clipId}.mp4`;
}
