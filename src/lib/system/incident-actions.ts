import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/system/job-log";

/**
 * Trang Sự cố — đọc toàn bộ sổ và hai thao tác của người trực: Ghi nhận,
 * Đã xử lý (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4).
 *
 * Ghi / gom / tự đóng vẫn chỉ do lượt tự kiểm nền làm (`incidents.ts`). File
 * này chỉ thêm hai bước người bấm:
 *
 *   Ghi nhận  : open → acknowledged. "Có người đang lo việc này." Sự cố VẪN
 *               được lượt tự kiểm gom tiếp và tự đóng khi khỏi.
 *   Đã xử lý  : open | acknowledged → resolved (lý do `manual`). Nếu thực ra
 *               chưa khỏi, lượt tự kiểm kế tiếp mở DÒNG MỚI — cố ý: đóng
 *               tay không được phép làm câm một lỗi còn đang xảy ra.
 *
 * Mỗi bước là một câu UPDATE có điều kiện trên trạng thái hiện tại. Hai
 * người bấm cùng lúc, hoặc lượt tự kiểm vừa đóng dòng đó, thì người sau nhận
 * `conflict` — không ghi đè lên nhau.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type IncidentAction = "acknowledge" | "resolve";

export const INCIDENT_ACTIONS: readonly IncidentAction[] = ["acknowledge", "resolve"];

type Status = "open" | "acknowledged" | "resolved";

/** Trạng thái được phép đi vào mỗi thao tác. */
export const ALLOWED_FROM: Record<IncidentAction, Status[]> = {
  acknowledge: ["open"],
  resolve: ["open", "acknowledged"],
};

/** Các cột đổi theo thao tác. Hàm thuần. */
export function transitionPatch(
  action: IncidentAction,
  actorUserId: string,
  now: Date,
): Record<string, unknown> {
  const at = now.toISOString();
  return action === "acknowledge"
    ? { status: "acknowledged", acknowledged_at: at, acknowledged_by: actorUserId }
    : { status: "resolved", resolved_at: at, resolved_reason: "manual" };
}

export interface IncidentRow {
  id: string;
  issue_key: string;
  check_key: string;
  organization_id: string | null;
  entity_id: string | null;
  severity: "crit" | "warn";
  peak_severity: "crit" | "warn";
  where_label: string;
  what_label: string;
  symptom: string;
  action: string;
  status: Status;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_reason: "auto_ok" | "out_of_scope" | "manual" | null;
}

export const INCIDENT_COLUMNS =
  "id, issue_key, check_key, organization_id, entity_id, severity, peak_severity, where_label, what_label, symptom, action, status, first_seen_at, last_seen_at, occurrence_count, acknowledged_at, acknowledged_by, resolved_at, resolved_reason";

export type TransitionResult =
  | { ok: true; incident: IncidentRow }
  | { ok: false; status: number; error: string; message: string };

export async function transitionIncident(
  admin: Admin,
  id: string,
  action: IncidentAction,
  actorUserId: string,
  now: Date,
): Promise<TransitionResult> {
  try {
    const { data, error } = await admin
      .from("warehouse_incidents")
      .update(transitionPatch(action, actorUserId, now))
      .eq("id", id)
      .in("status", ALLOWED_FROM[action])
      .select(INCIDENT_COLUMNS)
      .maybeSingle();
    if (error) return { ok: false, status: 500, error: "db_error", message: error.message };
    if (data) return { ok: true, incident: data as IncidentRow };

    // Không dòng nào khớp: không tồn tại, hoặc trạng thái đã đổi từ trước.
    const { data: cur } = await admin
      .from("warehouse_incidents")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (!cur) return { ok: false, status: 404, error: "not_found", message: "Không tìm thấy sự cố." };
    return {
      ok: false,
      status: 409,
      error: "conflict",
      message: conflictMessage(action, cur.status as Status),
    };
  } catch (err) {
    return { ok: false, status: 500, error: "db_error", message: errorMessage(err) };
  }
}

export function conflictMessage(action: IncidentAction, current: Status): string {
  if (current === "resolved") return "Sự cố đã được đóng trước đó (có thể lượt tự kiểm vừa thấy nó khỏi).";
  if (action === "acknowledge" && current === "acknowledged") return "Sự cố đã có người ghi nhận.";
  return `Không thể thực hiện khi sự cố đang ở trạng thái "${current}".`;
}

// ============================================================================
// Đọc
// ============================================================================

export type IncidentStatusFilter = "active" | "resolved" | "all";

export function parseStatusFilter(v: string | null): IncidentStatusFilter {
  return v === "resolved" || v === "all" ? v : "active";
}

export const INCIDENT_PAGE_SIZE = 200;

export async function listIncidents(
  admin: Admin,
  filter: { status: IncidentStatusFilter; orgId: string | null },
): Promise<{ ok: true; rows: IncidentRow[] } | { ok: false; missingTable: boolean; message: string }> {
  let q = admin.from("warehouse_incidents").select(INCIDENT_COLUMNS);
  if (filter.status === "active") q = q.in("status", ["open", "acknowledged"]);
  else if (filter.status === "resolved") q = q.eq("status", "resolved");
  // "system" = sự cố cấp hệ thống (không thuộc tổ chức nào).
  if (filter.orgId === "system") q = q.is("organization_id", null);
  else if (filter.orgId) q = q.eq("organization_id", filter.orgId);

  const { data, error } = await q
    // 'crit' < 'warn' theo chữ cái — tăng dần là nặng lên trước.
    .order("severity", { ascending: true })
    .order("last_seen_at", { ascending: false })
    .limit(INCIDENT_PAGE_SIZE);
  if (error) {
    const code = (error as { code?: string }).code;
    return {
      ok: false,
      missingTable: code === "42P01" || code === "PGRST205",
      message: error.message,
    };
  }
  return { ok: true, rows: (data as IncidentRow[] | null) ?? [] };
}
