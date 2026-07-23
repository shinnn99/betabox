import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET_NAME, BUCKET_TTL_HOURS } from "@/lib/watch/config";

/**
 * 1.1: helper cleanup clip bucket quá hạn.
 *
 * Chia sẻ logic giữa 2 route:
 *   - /api/admin/cleanup-expired-clips (POST + session admin OR x-cron-secret)
 *     — cho admin bấm tay khi test/vận hành.
 *   - /api/cron/cleanup-clips (GET + Authorization: Bearer $CRON_SECRET)
 *     — Vercel Cron chuẩn (docs 2026-06-02).
 *
 * Logic: fetch order_proof_clips có bucket_uploaded_at cũ hơn TTL 72h →
 * remove file bucket → reset cột (bucket_path=null, bucket_uploaded_at=null).
 * Reconcile watch endpoint sau đó thấy null → enqueue upload lại nếu cần.
 *
 * Idempotent: chạy lại không phá (remove file đã xóa → error nhẹ, update
 * null → null không đổi). Chấp nhận được với Vercel Cron duplicate delivery.
 */
export interface CleanupResult {
  ok: true;
  deleted: number;
  cutoff_iso: string;
  remove_errors?: string[];
}

export interface CleanupError {
  ok: false;
  error: "fetch_failed" | "db_update_failed";
  message: string;
  remove_errors?: string[];
}

export async function cleanupExpiredClips(): Promise<CleanupResult | CleanupError> {
  const admin = createAdminClient();
  const cutoffIso = new Date(Date.now() - BUCKET_TTL_HOURS * 3600 * 1000).toISOString();

  const { data: expired, error: fetchErr } = await admin
    .from("order_proof_clips")
    .select("id, packing_event_id, bucket_path, bucket_uploaded_at")
    .not("bucket_uploaded_at", "is", null)
    .lt("bucket_uploaded_at", cutoffIso);

  if (fetchErr) {
    return { ok: false, error: "fetch_failed", message: fetchErr.message };
  }

  const rows = expired ?? [];
  if (rows.length === 0) {
    return { ok: true, deleted: 0, cutoff_iso: cutoffIso };
  }

  const paths = rows.map((r) => r.bucket_path).filter((p): p is string => !!p);
  const removeErrors: string[] = [];
  if (paths.length > 0) {
    const { error: remErr } = await admin.storage.from(BUCKET_NAME).remove(paths);
    if (remErr) removeErrors.push(remErr.message);
  }

  // Set status='evicted' để phân biệt rõ "clip đã dọn khỏi cloud" với
  // "chưa upload xong" (2026-07-24). Trước đây chỉ set 2 cột NULL, giữ
  // status='ready' → helper trả bucket_missing → user thấy "Cắt clip thất
  // bại" sai bản chất (clip cắt xong rồi, chỉ file đã dọn). 'evicted' là
  // trạng thái cuối, /watch có nhánh riêng enqueue cut lại từ video gốc.
  const ids = rows.map((r) => r.id);
  const { error: updErr } = await admin
    .from("order_proof_clips")
    .update({ status: "evicted", bucket_path: null, bucket_uploaded_at: null })
    .in("id", ids);

  if (updErr) {
    return {
      ok: false,
      error: "db_update_failed",
      message: updErr.message,
      remove_errors: removeErrors.length > 0 ? removeErrors : undefined,
    };
  }

  return {
    ok: true,
    deleted: rows.length,
    cutoff_iso: cutoffIso,
    remove_errors: removeErrors.length > 0 ? removeErrors : undefined,
  };
}
