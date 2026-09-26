import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { resolveOrgParams, resolveWarehouseParams, type EffectiveParam } from "@/lib/config/effective";
import { getClipMaxSeconds } from "@/lib/config/template-store";
import {
  RETENTION_FIELDS,
  buildTimingPatch,
  retentionFieldError,
  sessionFallbackFrom,
  type RetentionField,
} from "@/lib/config/validate";

/**
 * Sửa cấu hình tổ chức / kho TỪ PLATFORM (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4).
 *
 * Khác route tenant ở ba chỗ, cả ba là lý do route platform phải tồn tại
 * riêng chứ không gọi lại route tenant:
 *
 *   1. `organization_id` lấy từ ĐƯỜNG DẪN, không từ phiên đăng nhập — admin
 *      nền tảng không thuộc tổ chức nào.
 *   2. Audit ghi vào `platform_audit_log` với danh tính admin nền tảng, không
 *      ghi thành "chủ tổ chức tự sửa" trong `audit_logs` của khách.
 *   3. Audit giữ cả giá trị TRƯỚC và SAU — sửa hộ khách thì phải trả lời
 *      được "trước đó là bao nhiêu" khi khách hỏi lại.
 *
 * Luật kiểm giá trị dùng CHUNG với route tenant (`src/lib/config/validate.ts`)
 * — hai đường sửa không được nhận hai khoảng khác nhau.
 *
 * Chỉ sửa được các ô tenant cũng sửa được. Trần kiện hoàn và các ô kỹ thuật
 * khác chưa mở: nới trần kiện hoàn phải chờ bản agent đợt 7.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type EditResult<T> =
  | { ok: true; before: Record<string, unknown>; after: Record<string, unknown>; params: T }
  | { ok: false; status: number; error: string; message?: string };

const ORG_COLUMNS = "id, name, retention_days, return_retention_days";
const WH_COLUMNS = "id, code, name, organization_id, packing_timing_config, session_fallback_seconds";

/** Bóc phần vá hạn lưu từ body. Ô không gửi thì không đụng. */
export function parseOrgConfigBody(
  body: unknown,
): { ok: true; update: Partial<Record<RetentionField, number | null>> } | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "Thân yêu cầu không hợp lệ." };
  const src = body as Record<string, unknown>;
  const update: Partial<Record<RetentionField, number | null>> = {};
  for (const field of RETENTION_FIELDS) {
    if (!(field in src)) continue;
    const message = retentionFieldError(field, src[field]);
    if (message) return { ok: false, message };
    update[field] = src[field] as number | null;
  }
  if (Object.keys(update).length === 0) return { ok: false, message: "Không có ô nào để sửa." };
  return { ok: true, update };
}

export async function editOrgConfig(
  admin: Admin,
  orgId: string,
  body: unknown,
): Promise<EditResult<EffectiveParam[]> & { orgName?: string }> {
  const parsed = parseOrgConfigBody(body);
  if (!parsed.ok) return { ok: false, status: 400, error: "validation", message: parsed.message };

  const { data: cur, error: readErr } = await admin
    .from("organizations")
    .select(ORG_COLUMNS)
    .eq("id", orgId)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  if (!cur) return { ok: false, status: 404, error: "not_found" };

  const { data: next, error } = await admin
    .from("organizations")
    .update(parsed.update)
    .eq("id", orgId)
    .select(ORG_COLUMNS)
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  // Kho dự phòng cho hạn lưu hàng hoàn = kho ĐẦU TIÊN, không lọc trạng thái —
  // đúng như route retention-plan và trang chi tiết tổ chức.
  const { data: firstWh } = await admin
    .from("warehouses")
    .select("packing_timing_config")
    .eq("organization_id", orgId)
    .limit(1)
    .maybeSingle();

  return {
    ok: true,
    orgName: cur.name as string,
    before: pick(cur, Object.keys(parsed.update)),
    after: pick(next, Object.keys(parsed.update)),
    params: resolveOrgParams(
      next as { retention_days: number | null; return_retention_days: number | null },
      firstWh?.packing_timing_config ?? null,
    ),
  };
}

/** Bóc phần vá cấu hình kho từ body — cùng luật với route tenant. */
export function parseWarehouseConfigBody(body: unknown):
  | { ok: true; timing: Record<string, number> | null; sessionFallback: number | null }
  | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "Thân yêu cầu không hợp lệ." };
  const src = body as Record<string, unknown>;
  const timing = buildTimingPatch(src.packing_timing_config);
  const sessionFallback = sessionFallbackFrom(src.session_fallback_seconds);
  if (!timing && sessionFallback === null) return { ok: false, message: "Không có ô nào để sửa." };
  return { ok: true, timing: timing as Record<string, number> | null, sessionFallback };
}

export async function editWarehouseConfig(
  admin: Admin,
  orgId: string,
  warehouseId: string,
  body: unknown,
): Promise<EditResult<EffectiveParam[]> & { warehouseCode?: string | null }> {
  const parsed = parseWarehouseConfigBody(body);
  if (!parsed.ok) return { ok: false, status: 400, error: "validation", message: parsed.message };

  // Kho phải thuộc đúng tổ chức trên đường dẫn — không cho sửa chéo bằng
  // cách ghép id tổ chức này với id kho của tổ chức khác.
  const { data: cur, error: readErr } = await admin
    .from("warehouses")
    .select(WH_COLUMNS)
    .eq("id", warehouseId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  if (!cur) return { ok: false, status: 404, error: "not_found" };

  const curCfg = (cur.packing_timing_config as Record<string, unknown> | null) ?? {};
  const update: Record<string, unknown> = {};
  if (parsed.timing) update.packing_timing_config = { ...curCfg, ...parsed.timing };
  if (parsed.sessionFallback !== null) update.session_fallback_seconds = parsed.sessionFallback;

  const { data: next, error } = await admin
    .from("warehouses")
    .update(update)
    .eq("id", warehouseId)
    .eq("organization_id", orgId)
    .select(WH_COLUMNS)
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  const nextCfg = (next.packing_timing_config as Record<string, unknown> | null) ?? {};
  const keys = Object.keys(parsed.timing ?? {});
  const before: Record<string, unknown> = pick(curCfg, keys);
  const after: Record<string, unknown> = pick(nextCfg, keys);
  if (parsed.sessionFallback !== null) {
    before.session_fallback_seconds = cur.session_fallback_seconds ?? null;
    after.session_fallback_seconds = next.session_fallback_seconds ?? null;
  }

  return {
    ok: true,
    warehouseCode: cur.code as string | null,
    before,
    after,
    params: resolveWarehouseParams(
      next as { packing_timing_config: unknown; session_fallback_seconds: number | null },
      await getClipMaxSeconds(admin),
    ),
  };
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}
