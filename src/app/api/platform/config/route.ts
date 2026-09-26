import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { resolveOrgParams, resolveWarehouseParams } from "@/lib/config/effective";
import { readPlatformTemplate } from "@/lib/config/template-store";
import { loadFleetRows, returnClipSecondsByOrg } from "@/lib/warehouse/fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/platform/config — bảng cấu hình của MỌI tổ chức và kho, một màn
// hình (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4). Trả lời "org nào đang chạy giá
// trị mặc định, kho nào bị kẹp" mà không phải mở từng tổ chức.
//
// Mọi con số qua phép giải Đặt / Thực dùng (`effective.ts`) — trang không tự
// tính. Kho dự phòng cho hạn lưu hàng hoàn lấy bằng ĐÚNG câu truy vấn của
// route retention-plan (`limit(1)` không sắp xếp), từng tổ chức một — gộp
// thành một truy vấn chung thì "kho đầu tiên" có thể khác và hai nơi ra hai
// con số.
// ============================================================================
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  const [orgsRes, whRes] = await Promise.all([
    admin
      .from("organizations")
      .select("id, name, status, retention_days, return_retention_days")
      .order("name"),
    admin
      .from("warehouses")
      .select("id, code, name, status, organization_id, packing_timing_config, session_fallback_seconds")
      .eq("status", "active")
      .order("code"),
  ]);
  if (orgsRes.error) return NextResponse.json({ error: orgsRes.error.message }, { status: 500 });
  if (whRes.error) return NextResponse.json({ error: whRes.error.message }, { status: 500 });

  const orgs = orgsRes.data ?? [];
  const fallbacks = await Promise.all(
    orgs.map((o) =>
      admin
        .from("warehouses")
        .select("packing_timing_config")
        .eq("organization_id", o.id)
        .limit(1)
        .then(({ data }) => data?.[0]?.packing_timing_config ?? null),
    ),
  );

  const warehouses = whRes.data ?? [];
  // Trần clip đang áp — cùng con số với máy cắt clip.
  const template = await readPlatformTemplate(admin);
  const clipMax = template.template.clip_max_seconds;
  // Trần clip kiện hoàn theo khả năng agent của từng tổ chức (đợt 7).
  const returnClipByOrg = returnClipSecondsByOrg((await loadFleetRows(admin, { activeOnly: true })).rows, clipMax);
  return NextResponse.json({
    template,
    // Chỉ platform_owner sửa được — giao diện ẩn nút sửa với người còn lại.
    canEdit: ctx.platformRole === "platform_owner",
    orgs: orgs.map((o, i) => ({
      id: o.id as string,
      name: o.name as string,
      status: o.status as string,
      params: resolveOrgParams(o, fallbacks[i]),
      warehouses: warehouses
        .filter((w) => w.organization_id === o.id)
        .map((w) => ({
          id: w.id as string,
          code: w.code as string | null,
          name: w.name as string | null,
          params: resolveWarehouseParams(w, clipMax, returnClipByOrg.get(o.id) ?? clipMax),
        })),
    })),
  });
}
