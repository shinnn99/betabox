import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isError, requirePermissionStrict } from "@/lib/supabase/guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Hành động hàng loạt trên trang Bằng chứng hoàn hàng — vị trí tương ứng
 * với "Đánh dấu lỗi" của trang Bằng chứng giao hàng.
 *
 * Nhận id KIỆN HOÀN (packing_event_id), không phải id hồ sơ: trang danh
 * sách chọn theo dòng, và một dòng có thể không có hồ sơ (hàng ổn) — những
 * dòng đó được bỏ qua lặng lẽ, số `updated` nói thật đã đổi bao nhiêu.
 *
 * Chỉ hai chiều người dùng được đi, giống route sửa từng hồ sơ: "Đã khiếu
 * nại" và "Không cần". Hết hạn là việc của hệ thống.
 */

const MAX_IDS = 200;

export async function POST(req: NextRequest) {
  // Đổi trạng thái hồ sơ khiếu nại là thao tác ghi — Viewer chỉ xem.
  const ctx = await requirePermissionStrict("return.operate", req);
  if (isError(ctx)) return ctx;

  let body: { event_ids?: unknown; status?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const raw = Array.isArray(body.event_ids) ? body.event_ids : null;
  if (!raw || raw.length === 0) {
    return NextResponse.json({ error: "event_ids_required" }, { status: 400 });
  }
  if (raw.length > MAX_IDS) {
    return NextResponse.json({ error: "too_many_ids", max: MAX_IDS }, { status: 400 });
  }
  const eventIds = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (eventIds.length === 0) {
    return NextResponse.json({ error: "event_ids_required" }, { status: 400 });
  }

  if (body.status !== "submitted" && body.status !== "dismissed") {
    return NextResponse.json(
      { error: "invalid_status", message: "Chỉ đổi được sang 'submitted' hoặc 'dismissed'." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("return_claims")
    .update({ status: body.status, updated_by: ctx.userId })
    .eq("organization_id", ctx.organizationId)
    .in("packing_event_id", eventIds)
    // Hồ sơ đã hết hạn hoặc đã bỏ thì không sửa ngược được.
    .in("status", ["open", "submitted"])
    .select("id");

  if (error) {
    return NextResponse.json({ error: "update_failed", message: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, updated: (data ?? []).length, status: body.status });
}
