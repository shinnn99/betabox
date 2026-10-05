import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET_NAME, BUCKET_TTL_HOURS } from "@/lib/watch/config";

/**
 * Dung lượng video đang nằm trên Supabase Storage — theo kho, và theo từng file.
 *
 * ══ MỘT ĐIỀU PHẢI HIỂU TRƯỚC KHI ĐỌC SỐ Ở ĐÂY ══
 *
 * Bucket này KHÔNG phải nơi lưu video 30 ngày. Nó là CACHE 72 giờ
 * (`BUCKET_TTL_HOURS`). Nguồn chân lý của bằng chứng là segment thô dưới máy
 * kho, giữ theo `organizations.retention_days`. Clip hết 72h thì
 * `cleanupExpiredClips()` xoá object và đặt `status='evicted'` — xem lại vẫn
 * được, vì `/watch` tự cắt lại từ segment gốc.
 *
 * Hệ quả cho trang: cột "còn lại" ở đây tính bằng GIỜ tới lượt dọn, KHÔNG
 * phải `retention_days`. Trộn hai con số đó là cách chắc chắn nhất để người
 * đọc tưởng mất bằng chứng khi thật ra chỉ là hết cache.
 *
 * ══ VÌ SAO ĐỌC `storage.objects` CHỨ KHÔNG CHỈ CỘNG `clip_size_bytes` ══
 *
 * Vì hai nguồn KHÔNG khớp nhau, và sai lệch là thật: đo ngày 02/10/2026 thấy
 * bucket có 34 object / 1421 MB trong khi bảng clip chỉ nhận 31 / 1354 MB —
 * 3 object mồ côi, 67 MB, không dòng clip nào trỏ tới. Cộng `clip_size_bytes`
 * cho ra một con số LUÔN NHỎ HƠN thực tế, và chênh lệch đó chính là thứ làm
 * hoá đơn Supabase cao hơn ước lượng mà không ai giải thích được.
 *
 * Nên: `storage.objects` là mẫu số, bảng clip chỉ để GÁN TÊN (kho nào, đơn
 * nào). Object không gán được thì vào nhóm "không rõ chủ" chứ không bị bỏ
 * khỏi tổng.
 */

type Admin = ReturnType<typeof createAdminClient>;

/** Một file video thật trên bucket. */
export interface StorageObjectRow {
  /** Đường dẫn trong bucket — cũng là khoá nối sang `order_proof_clips`. */
  path: string;
  sizeBytes: number;
  createdAt: string;
  /** null = object mồ côi, không dòng clip nào trỏ tới. */
  orgId: string | null;
  orgName: string | null;
  waybillCode: string | null;
  /** Giờ còn lại trước lượt dọn 72h. Âm = quá hạn mà chưa bị dọn. */
  hoursLeft: number;
}

export interface OrgStorageRow {
  orgId: string | null;
  orgName: string;
  objects: number;
  bytes: number;
  /** Object quá hạn 72h mà cron chưa dọn — dấu hiệu cron chết. */
  overdueObjects: number;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
}

export interface StorageUsageView {
  available: true;
  bucket: string;
  ttlHours: number;
  totalObjects: number;
  totalBytes: number;
  /** Tổng theo bảng clip — để đối chiếu, KHÔNG phải con số chính. */
  accountedBytes: number;
  orphanObjects: number;
  orphanBytes: number;
  overdueObjects: number;
  orgs: OrgStorageRow[];
  objects: StorageObjectRow[];
  /** Cắt bớt khi bucket quá nhiều file — nói ra chứ không im lặng. */
  truncated: boolean;
}

export type StorageUsageResult = StorageUsageView | { available: false; reason: string };

/**
 * Trần số file đọc về. Bucket là cache 72h nên thực tế chỉ vài chục file;
 * trần này là chặn trường hợp cron chết nhiều ngày làm bucket phình.
 * Chạm trần thì `truncated=true` và trang phải nói ra — tổng ở dưới trần sẽ
 * THIẾU, và một con số thiếu mà im lặng còn tệ hơn không có số.
 */
const MAX_OBJECTS = 2000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Đọc dung lượng bucket + gán chủ cho từng file.
 *
 * Dùng RPC `storage_usage_objects` (schema `storage` không lộ qua PostgREST
 * nên không `.from("storage.objects")` được). Hàm RPC chưa có → trả
 * `available:false` kèm tên migration, KHÔNG trả 0: "0 byte" đọc như bucket
 * rỗng, trong khi sự thật là chưa đo được.
 */
export async function readStorageUsage(admin: Admin): Promise<StorageUsageResult> {
  let rows: Array<{ name: string; size_bytes: number | string | null; created_at: string }>;
  try {
    const { data, error } = await admin.rpc("storage_usage_objects", {
      p_bucket: BUCKET_NAME,
      p_limit: MAX_OBJECTS,
    });
    if (error) {
      // 42883 = hàm chưa tồn tại; PGRST202 = PostgREST không thấy hàm.
      const code = (error as { code?: string }).code;
      if (code === "42883" || code === "PGRST202") {
        return {
          available: false,
          reason:
            "Chưa có hàm đọc dung lượng bucket — cần chạy migration 20261002090000_storage_usage_fn.sql.",
        };
      }
      return { available: false, reason: `Không đọc được dung lượng bucket: ${error.message}` };
    }
    rows = (data as typeof rows | null) ?? [];
  } catch (err) {
    return { available: false, reason: `Không đọc được dung lượng bucket: ${errorMessage(err)}` };
  }

  // Gán tên cho từng file. Chỉ lấy clip CÒN trên bucket (`bucket_path` not
  // null) — clip `evicted` đã rời bucket, kéo vào đây chỉ làm nhiễu.
  const byPath = new Map<string, { orgId: string; waybill: string | null }>();
  const { data: clipRows } = await admin
    .from("order_proof_clips")
    .select("bucket_path, organization_id, waybill_code")
    .not("bucket_path", "is", null);
  for (const c of (clipRows ?? []) as Array<{
    bucket_path: string;
    organization_id: string;
    waybill_code: string | null;
  }>) {
    byPath.set(c.bucket_path, { orgId: c.organization_id, waybill: c.waybill_code });
  }

  const { data: orgRows } = await admin.from("organizations").select("id, name");
  const orgNameById = new Map(
    ((orgRows ?? []) as Array<{ id: string; name: string }>).map((o) => [o.id, o.name]),
  );

  const nowMs = Date.now();
  const ttlMs = BUCKET_TTL_HOURS * 3600_000;

  const objects: StorageObjectRow[] = rows.map((r) => {
    const owner = byPath.get(r.name) ?? null;
    const createdMs = Date.parse(r.created_at);
    // Làm tròn 1 chữ số: "còn 4.2 giờ" đủ dùng, mà không giả vờ chính xác
    // tới phút — lượt dọn chạy theo nhịp cron chứ không đúng từng giây.
    const hoursLeft = Number.isFinite(createdMs)
      ? Math.round(((createdMs + ttlMs - nowMs) / 3600_000) * 10) / 10
      : 0;
    return {
      path: r.name,
      // `metadata->>'size'` về dạng chuỗi qua JSON — ép số ở đây, không tin
      // kiểu dữ liệu đi qua ranh giới RPC.
      sizeBytes: Number(r.size_bytes ?? 0),
      createdAt: r.created_at,
      orgId: owner?.orgId ?? null,
      orgName: owner ? (orgNameById.get(owner.orgId) ?? owner.orgId) : null,
      waybillCode: owner?.waybill ?? null,
      hoursLeft,
    };
  });

  const byOrg = new Map<string, OrgStorageRow>();
  for (const o of objects) {
    // Gom mọi object mồ côi vào MỘT dòng, khoá rỗng.
    const key = o.orgId ?? "";
    const row = byOrg.get(key) ?? {
      orgId: o.orgId,
      orgName: o.orgName ?? "Không rõ chủ",
      objects: 0,
      bytes: 0,
      overdueObjects: 0,
      oldestCreatedAt: null,
      newestCreatedAt: null,
    };
    row.objects += 1;
    row.bytes += o.sizeBytes;
    if (o.hoursLeft < 0) row.overdueObjects += 1;
    if (!row.oldestCreatedAt || o.createdAt < row.oldestCreatedAt) row.oldestCreatedAt = o.createdAt;
    if (!row.newestCreatedAt || o.createdAt > row.newestCreatedAt) row.newestCreatedAt = o.createdAt;
    byOrg.set(key, row);
  }

  const orphans = objects.filter((o) => o.orgId === null);

  return {
    available: true,
    bucket: BUCKET_NAME,
    ttlHours: BUCKET_TTL_HOURS,
    totalObjects: objects.length,
    totalBytes: objects.reduce((n, o) => n + o.sizeBytes, 0),
    accountedBytes: objects
      .filter((o) => o.orgId !== null)
      .reduce((n, o) => n + o.sizeBytes, 0),
    orphanObjects: orphans.length,
    orphanBytes: orphans.reduce((n, o) => n + o.sizeBytes, 0),
    overdueObjects: objects.filter((o) => o.hoursLeft < 0).length,
    orgs: [...byOrg.values()].sort((a, b) => b.bytes - a.bytes),
    objects: objects.sort((a, b) => b.sizeBytes - a.sizeBytes),
    truncated: rows.length >= MAX_OBJECTS,
  };
}
