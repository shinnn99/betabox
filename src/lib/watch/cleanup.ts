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

export interface CleanupOptions {
  /**
   * Giới hạn phạm vi dọn vào ĐÚNG một org.
   *
   * `undefined` = toàn hệ, và CHỈ được dùng khi caller đã chứng minh
   * quyền toàn hệ (cron secret). Đường session admin BẮT BUỘC truyền
   * org của chính người bấm — xem lý do ở khối cross-tenant bên dưới.
   */
  organizationId?: string;
  /**
   * Admin client tiêm vào — chỉ dùng cho test. Bỏ trống thì tự tạo.
   * Cùng nếp với `reconcileStalePendingClips(admin, …)`: phụ thuộc DB
   * nói ra ở chữ ký thay vì giấu trong thân hàm, nhờ vậy kiểm được
   * phạm vi org mà không cần dựng cả Supabase.
   */
  client?: ReturnType<typeof createAdminClient>;
}

/**
 * ===================================================================
 * CROSS-TENANT — vì sao hàm này phải nhận `organizationId`
 *
 * Lỗ đã có thật (phát hiện 12/08/2026, sửa cùng ngày): route
 * `/api/admin/cleanup-expired-clips` cho vào bằng `profile.role ===
 * 'admin'` — đó là admin của MỘT org bất kỳ, không phải platform admin.
 * Hàm này lúc đó không nhận org và query không có filter
 * `organization_id`, nên admin org A bấm nút là xoá clip khỏi bucket +
 * set status='evicted' cho clip của MỌI org.
 *
 * Không phải rò rỉ dữ liệu (không org nào đọc được nội dung org khác),
 * nhưng là GHI xuyên tenant: khách A xoá được bằng chứng của khách B
 * khỏi cloud. Clip còn cắt lại được từ segment gốc nếu chưa quá hạn lưu
 * trữ, nên không mất vĩnh viễn — nhưng nó phá đúng cam kết cách ly mà
 * mô hình nhiều khách chung một project dựa vào.
 *
 * Quy tắc từ đây: mọi caller phải nói rõ phạm vi. Toàn hệ là ngoại lệ
 * phải chứng minh, không phải mặc định.
 * ===================================================================
 */
export async function cleanupExpiredClips(
  options: CleanupOptions = {},
): Promise<CleanupResult | CleanupError> {
  const admin = options.client ?? createAdminClient();
  const cutoffIso = new Date(Date.now() - BUCKET_TTL_HOURS * 3600 * 1000).toISOString();
  const orgId = options.organizationId;

  let fetchQuery = admin
    .from("order_proof_clips")
    .select("id, packing_event_id, bucket_path, bucket_uploaded_at")
    .not("bucket_uploaded_at", "is", null)
    .lt("bucket_uploaded_at", cutoffIso);
  if (orgId) fetchQuery = fetchQuery.eq("organization_id", orgId);

  const { data: expired, error: fetchErr } = await fetchQuery;

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
  // Lặp lại filter org ở bước ghi (defense in depth): id đã lấy từ fetch
  // đã lọc, nhưng nếu ai đó sửa fetch mà quên, lớp này vẫn chặn ghi
  // xuyên tenant.
  let updateQuery = admin
    .from("order_proof_clips")
    .update({ status: "evicted", bucket_path: null, bucket_uploaded_at: null })
    .in("id", ids);
  if (orgId) updateQuery = updateQuery.eq("organization_id", orgId);
  const { error: updErr } = await updateQuery;

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
