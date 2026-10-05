import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET_NAME } from "@/lib/watch/config";

/**
 * Dọn object MỒ CÔI trên bucket clip — lượt quét đi TỪ BUCKET.
 *
 * ══ VÌ SAO CẦN LƯỢT QUÉT THỨ HAI ══
 *
 * `cleanupExpiredClips()` đi từ **bảng `order_proof_clips`**: tìm dòng có
 * `bucket_uploaded_at` quá 72h rồi xoá file tương ứng. Cách đó không bao giờ
 * nhìn thấy object mà KHÔNG dòng nào trỏ tới — nó nằm trên bucket tính tiền
 * lưu trữ vĩnh viễn.
 *
 * Sinh ra thế nào: agent upload file lên bucket THÀNH CÔNG rồi mới báo về để
 * cloud ghi `bucket_path`. Bước báo về hỏng (mạng rớt, clip rơi vào `failed`,
 * agent chết giữa chừng) → file có thật, DB không biết. Đo 02/10/2026: bucket
 * 34 object/1421 MB trong khi bảng clip nhận 31/1354 MB; 30 ngày gần nhất có
 * 16 clip `status='failed'`, tức nguồn sinh vẫn đang sống.
 *
 * ══ ĐIỀU NGUY HIỂM NHẤT CỦA CÁCH ĐI TỪ BUCKET ══
 *
 * Một clip ĐANG upload có file trên bucket mà CHƯA có `bucket_path` — nhìn
 * y hệt mồ côi. Quét mù sẽ xoá đúng cái file vừa upload xong, biến một lượt
 * dọn thành máy phá bằng chứng.
 *
 * Chốt chặn là `MIN_ORPHAN_AGE_HOURS`: chỉ đụng object GIÀ hơn ngần đó. Upload
 * một clip mất vài giây tới vài phút; để 24 giờ là dư sức an toàn, mà vẫn dọn
 * được trước khi rác tích lại. Đây KHÔNG phải con số làm đẹp — nó là khoảng
 * cách giữa "file mới lên, DB chưa kịp ghi" và "file bị bỏ quên thật".
 *
 * Hệ quả cố ý: object mồ côi mới sinh sẽ sống thêm tối đa 24h. Chấp nhận
 * được — vài chục MB đổi lấy việc không bao giờ xoá nhầm clip đang upload.
 */

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Object phải già hơn ngần này mới được coi là mồ côi.
 *
 * Đổi số này là đổi mức rủi ro xoá nhầm clip đang upload — đọc kỹ khối ghi
 * chú trên trước khi hạ xuống.
 */
export const MIN_ORPHAN_AGE_HOURS = 24;

/** Trần số object xử lý một lượt, chặn lượt quét thành truy vấn nặng. */
const MAX_SCAN = 2000;

export interface OrphanSweepResult {
  ok: true;
  /** Số object đã xoá. */
  deleted: number;
  /** Tổng byte giải phóng. */
  freedBytes: number;
  /** Mồ côi nhưng CHƯA đủ tuổi — đếm để biết nhịp sinh rác, không xoá. */
  tooYoung: number;
  scanned: number;
  errors?: string[];
}

export interface OrphanSweepError {
  ok: false;
  error: "scan_failed" | "remove_failed";
  message: string;
}

export interface OrphanSweepOptions {
  client?: Admin;
  /** Chạy khô — tính ra danh sách nhưng KHÔNG xoá. */
  dryRun?: boolean;
}

/**
 * Quét bucket, xoá object không dòng clip nào nhận VÀ đã đủ già.
 *
 * KHÔNG nhận `organizationId`, và đó là chủ đích: object mồ côi theo định
 * nghĩa là thứ không gắn được với org nào (đường dẫn có thể chứa id org,
 * nhưng chính cái đường dẫn đó mới là thứ không đáng tin — nếu tin được thì
 * đã không mồ côi). Vì vậy đây là lượt TOÀN HỆ, chỉ cron secret gọi, giống
 * đường cron của `cleanupExpiredClips`.
 */
export async function sweepOrphanObjects(
  options: OrphanSweepOptions = {},
): Promise<OrphanSweepResult | OrphanSweepError> {
  const admin = options.client ?? createAdminClient();

  // Đọc object qua RPC (schema `storage` không lộ qua PostgREST).
  let objects: Array<{ name: string; size_bytes: number; created_at: string }>;
  try {
    const { data, error } = await admin.rpc("storage_usage_objects", {
      p_bucket: BUCKET_NAME,
      p_limit: MAX_SCAN,
    });
    if (error) return { ok: false, error: "scan_failed", message: error.message };
    objects = (data as typeof objects | null) ?? [];
  } catch (err) {
    return {
      ok: false,
      error: "scan_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Dòng clip nào đang GIỮ CHỖ. Đọc SAU khi liệt kê bucket, không phải trước:
  // clip upload xong trong lúc đang liệt kê sẽ có mặt ở đây và được tha.
  const { data: clips, error: clipErr } = await admin
    .from("order_proof_clips")
    .select("bucket_path")
    .not("bucket_path", "is", null);
  if (clipErr) return { ok: false, error: "scan_failed", message: clipErr.message };
  const claimed = new Set((clips ?? []).map((c) => c.bucket_path as string));

  const cutoffMs = Date.now() - MIN_ORPHAN_AGE_HOURS * 3600_000;
  const orphans = objects.filter((o) => !claimed.has(o.name));
  const doomed = orphans.filter((o) => Date.parse(o.created_at) < cutoffMs);
  const tooYoung = orphans.length - doomed.length;

  const freedBytes = doomed.reduce((n, o) => n + Number(o.size_bytes ?? 0), 0);

  if (doomed.length === 0 || options.dryRun) {
    return {
      ok: true,
      deleted: 0,
      freedBytes: options.dryRun ? freedBytes : 0,
      tooYoung,
      scanned: objects.length,
    };
  }

  const { error: remErr } = await admin.storage
    .from(BUCKET_NAME)
    .remove(doomed.map((o) => o.name));
  if (remErr) return { ok: false, error: "remove_failed", message: remErr.message };

  return {
    ok: true,
    deleted: doomed.length,
    freedBytes,
    tooYoung,
    scanned: objects.length,
  };
}
