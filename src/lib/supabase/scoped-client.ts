import "server-only";
// Re-export từ @supabase/supabase-js thay vì @supabase/postgrest-js trực tiếp:
// pnpm strict mode (Vercel) không cho import transitive dep — supabase-js đã
// re-export type này, dùng đường re-export là sạch không cần thêm dep.
import type { PostgrestFilterBuilder } from "@supabase/supabase-js";
import { createClient } from "./server";
import { createAdminClient } from "./admin";
import type { ApiContext } from "./guard";

// ============================================================================
// getScopedClient — Gói hybrid session/admin + auto-filter theo ctx.organizationId.
//
// Vấn đề gốc (A3 migration 2026-07-04):
//   SELECT policy 22 bảng bỏ nhánh `is_platform_admin() OR` (SQL không giới
//   hạn org-token được → platform session-client thấy all = leak ca 5).
//   Sau A3, platform session-client → 0-row. Buộc platform dùng admin client
//   bypass RLS + filter app-layer `.eq('organization_id', ctx.organizationId)`.
//
// Cạnh nguy sau A3:
//   Platform mất lớp RLS defense-in-depth. Chỉ còn app-filter chặn cross-org.
//   Route platform quên filter = leak all. Đây CHÍNH là bug ca 5 (warehouses
//   quên .eq → leak all) — không được tái diễn qua "route nhớ .eq".
//
// Cơ chế đóng "quên .eq":
//   Helper `scopedQuery(table)` trả wrapper có `.select(...)` bọc:
//     - Platform: tự chain `.eq('organization_id', ctx.organizationId)` sau
//       .select() (là chỗ có thể chain filter — PostgrestFilterBuilder).
//     - Tenant: no-op (RLS đỡ).
//   Route gọi `scoped.select('warehouses', 'id, code')` → auto-filter platform.
//   Nếu route muốn chain thêm `.eq('warehouse_id', x)`, `.order(...)`, etc.
//   → chain bình thường trên kết quả trả về.
//
// Ranh giới cứng:
//   - Chỉ SELECT. INSERT/UPDATE/DELETE tự set organization_id + qua guard vế 4.
//   - "quên" đóng bằng cơ chế — không loại hoàn toàn (route vẫn có thể gọi
//     client trần). Nhưng helper là MỘT điểm review được, hơn 7+ .eq rải.
// ============================================================================

type OrgScopedTable =
  | "agent_commands"
  | "audit_logs"
  | "camera_recording_files"
  | "camera_recording_sessions"
  | "cameras"
  | "order_proof_clips"
  | "orders"
  | "packing_events"
  | "packing_stations"
  | "staff_profiles"
  | "staff_qr_credentials"
  | "staff_qr_scan_results"
  | "staff_warehouse_assignments"
  | "staff_work_session_events"
  | "staff_work_sessions"
  | "station_device_assignments"
  | "station_devices"
  | "user_profiles"
  | "warehouse_agents"
  | "warehouse_scan_raw_events"
  | "warehouses";

// Row-shape "mềm" cho builder trả về: caller khai <Row> để giữ type ở data,
// còn key `.eq/.in/.order` mở any để lọc theo cột không có trong Row-select
// (VD: SELECT không lấy `status` nhưng vẫn `.eq('status','active')`).
// Không kéo theo instantiation-too-deep (TS2589) từ generic createClient chain.
/* eslint-disable @typescript-eslint/no-explicit-any */
type ScopedFilterBuilder<Row extends Record<string, unknown>> = PostgrestFilterBuilder<
  any,
  any,
  any,
  Row[],
  string,
  unknown,
  "GET",
  false
>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ScopedClient {
  isPlatform: boolean;
  organizationId: string;
  /**
   * SELECT bọc: tự áp `.eq('organization_id', ctx.organizationId)` cho
   * nhánh platform (admin bypass RLS → cần filter app-layer).
   *
   * Nhánh tenant: no-op filter (RLS đỡ), trả select builder nguyên.
   *
   * Chain thêm được: `.select('warehouses', 'id, code').eq('warehouse_id', x).order('code')`
   *
   * Row generic để caller pin shape: `scoped.select<{ id: string }>(...)`.
   * Mặc định `Record<string, unknown>` — chain filter OK, đọc data cần cast.
   */
  select: <Row extends Record<string, unknown> = Record<string, unknown>>(
    table: OrgScopedTable,
    columns: string,
  ) => ScopedFilterBuilder<Row>;
}

export async function getScopedClient(ctx: ApiContext): Promise<ScopedClient> {
  if (ctx.isPlatform) {
    const admin = createAdminClient();
    return {
      isPlatform: true,
      organizationId: ctx.organizationId,
      select: <Row extends Record<string, unknown> = Record<string, unknown>>(
        table: OrgScopedTable,
        columns: string,
      ) =>
        admin
          .from(table)
          .select(columns)
          .eq("organization_id", ctx.organizationId) as unknown as ScopedFilterBuilder<Row>,
    };
  }

  const supabase = await createClient();
  return {
    isPlatform: false,
    organizationId: ctx.organizationId,
    // Tenant: RLS chặn cross-tenant. Không auto-filter.
    select: <Row extends Record<string, unknown> = Record<string, unknown>>(
      table: OrgScopedTable,
      columns: string,
    ) => supabase.from(table).select(columns) as unknown as ScopedFilterBuilder<Row>,
  };
}

// ============================================================================
// Cạnh organizations: bảng này lookup bằng `id`, KHÔNG `organization_id`.
// Không cover trong helper generic. Route đọc organizations tự
// `.eq('id', ctx.organizationId)`. (Hiện chỉ /api/organization dùng.)
// ============================================================================
