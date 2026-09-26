import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { CheckEntity, SystemCheck } from "@/lib/system/checks";
import type { SystemIssue } from "@/lib/system/status-view";
import { errorMessage } from "@/lib/system/job-log";

/**
 * Sổ sự cố — mở, gom và đóng dòng trong `warehouse_incidents` sau mỗi lượt
 * tự kiểm (kế hoạch VAN-HANH-NHIEU-KHO, đợt 3).
 *
 * SỔ GHI ĐÚNG DANH SÁCH "CẦN CHÚ Ý" — nhận đầu vào là `buildIssues()`, không
 * tự định nghĩa lại cái gì là sự cố. Trang và sổ không được nói hai câu
 * khác nhau.
 *
 * BA LUẬT, mỗi luật chặn một kiểu hỏng đã biết:
 *
 *   1. Chỉ `crit` / `warn` mới thành sự cố. "Chưa đo được" (`unknown`) KHÔNG
 *      — đo được 26/09/2026: một lượt chạy 12 mục song song có một mục mất
 *      nguồn vì mạng chập một nhịp, sáu lượt sau đều sạch. Ghi cả `unknown`
 *      là sổ đầy dòng mở-rồi-đóng vô nghĩa.
 *
 *   2. Chỉ đóng khi có BẰNG CHỨNG DƯƠNG. Đối tượng vắng mặt trong danh sách
 *      "Cần chú ý" chưa chắc đã khoẻ: mục kiểm có thể đang mất nguồn, hoặc
 *      kho vào giờ nghỉ (`skipped`). Đóng những ca đó là camera hỏng lúc 17h
 *      bị "đóng" lúc 18h rồi mở dòng MỚI sáng hôm sau — mất mốc bắt đầu thật.
 *
 *   3. Gom theo `issue_key`: một sự cố kéo dài là MỘT dòng, `occurrence_count`
 *      tăng mỗi lượt. Không gom thì sổ ngộp như `agent_log_events`.
 *
 * KHÔNG BAO GIỜ NÉM. Route tự kiểm có luật "không bao giờ 500 vì một mục
 * hỏng" — sổ hỏng (chưa chạy migration, mạng chập) thì trả về tóm tắt có
 * lỗi, route vẫn gửi Lark như cũ.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type IncidentSeverity = "crit" | "warn";

export interface IncidentCandidate {
  issueKey: string;
  checkKey: string;
  orgId: string | null;
  entityId: string | null;
  severity: IncidentSeverity;
  where: string;
  what: string;
  symptom: string;
  action: string;
}

export interface ActiveIncident {
  id: string;
  issue_key: string;
  check_key: string;
  entity_id: string | null;
  severity: IncidentSeverity;
  peak_severity: IncidentSeverity;
  occurrence_count: number;
}

export type ResolveDecision =
  | { resolve: false; why: string }
  | { resolve: true; reason: "auto_ok" | "out_of_scope" };

export interface IncidentSyncSummary {
  opened: number;
  bumped: number;
  resolvedOk: number;
  resolvedOutOfScope: number;
  kept: number;
  errors: string[];
}

/** Luật 1: chỉ crit / warn thành sự cố. */
export function incidentCandidates(issues: SystemIssue[]): IncidentCandidate[] {
  return issues
    .filter((i): i is SystemIssue & { status: IncidentSeverity } => i.status === "crit" || i.status === "warn")
    .map((i) => ({
      issueKey: i.id,
      checkKey: i.checkKey,
      orgId: i.orgId,
      entityId: i.entityId,
      severity: i.status,
      where: i.where,
      what: i.what,
      symptom: i.symptom,
      action: i.action,
    }));
}

/**
 * Luật 2: một sự cố đang mở mà lượt này KHÔNG còn trong danh sách — có đóng
 * được không. Hàm thuần, kiểm từng nhánh được.
 */
export function decideResolution(
  incident: Pick<ActiveIncident, "check_key" | "entity_id">,
  checks: SystemCheck[],
): ResolveDecision {
  const check = checks.find((c) => c.key === incident.check_key);
  // Mục kiểm không còn trong bộ (đã gỡ khỏi mã nguồn) thì không ai đánh
  // giá lại được nữa — để mở là mở mãi.
  if (!check) return { resolve: true, reason: "out_of_scope" };
  // Mất nguồn / chưa đo được: không có bằng chứng là đã khỏi.
  if (check.status === "unknown") return { resolve: false, why: "mục kiểm chưa đo được" };

  if (incident.entity_id === null) {
    return check.status === "ok"
      ? { resolve: true, reason: "auto_ok" }
      : { resolve: false, why: `mục kiểm đang ${check.status}` };
  }

  const entity: CheckEntity | undefined = check.entities?.find((e) => e.id === incident.entity_id);
  // Mục kiểm chạy được mà đối tượng biến mất khỏi danh sách: camera đã lưu
  // trữ, tổ chức tắt theo dõi. Không phải "đã khỏi" — ghi lý do riêng.
  if (!entity) return { resolve: true, reason: "out_of_scope" };
  if (entity.status === "ok") return { resolve: true, reason: "auto_ok" };
  // skipped (kho nghỉ), unknown, hoặc vẫn xấu: giữ nguyên.
  return { resolve: false, why: `đối tượng đang ${entity.status}` };
}

const RANK: Record<IncidentSeverity, number> = { warn: 1, crit: 2 };
const higher = (a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity =>
  RANK[a] >= RANK[b] ? a : b;

/** Chạy song song theo lô — 50 kho có thể là vài trăm dòng mỗi lượt. */
async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export async function syncIncidents(
  admin: Admin,
  input: { checks: SystemCheck[]; issues: SystemIssue[]; now: Date },
): Promise<IncidentSyncSummary> {
  const summary: IncidentSyncSummary = {
    opened: 0,
    bumped: 0,
    resolvedOk: 0,
    resolvedOutOfScope: 0,
    kept: 0,
    errors: [],
  };
  const nowIso = input.now.toISOString();

  let active: ActiveIncident[];
  try {
    const { data, error } = await admin
      .from("warehouse_incidents")
      .select("id, issue_key, check_key, entity_id, severity, peak_severity, occurrence_count")
      .in("status", ["open", "acknowledged"]);
    if (error) throw new Error(error.message);
    active = (data as ActiveIncident[] | null) ?? [];
  } catch (err) {
    // Hay gặp nhất: chưa chạy migration. Không đọc được sổ thì không ghi gì
    // — ghi mù là đẻ dòng trùng.
    summary.errors.push(`đọc sổ: ${errorMessage(err)}`);
    return summary;
  }

  const byKey = new Map(active.map((r) => [r.issue_key, r]));
  const candidates = incidentCandidates(input.issues);
  const seen = new Set(candidates.map((c) => c.issueKey));

  // Mở mới hoặc gom vào dòng đang mở.
  await inBatches(candidates, 10, async (c) => {
    const existing = byKey.get(c.issueKey);
    const fields = {
      severity: c.severity,
      where_label: c.where,
      what_label: c.what,
      symptom: c.symptom,
      action: c.action,
      last_seen_at: nowIso,
    };
    try {
      if (existing) {
        // Đếm theo kiểu đọc-rồi-ghi: hai lượt chồng nhau có thể mất một lần
        // đếm. Chấp nhận — đây là số lượt đã thấy, không phải sổ cái tiền.
        const { error } = await admin
          .from("warehouse_incidents")
          .update({
            ...fields,
            peak_severity: higher(existing.peak_severity, c.severity),
            occurrence_count: existing.occurrence_count + 1,
          })
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
        summary.bumped++;
      } else {
        const { error } = await admin.from("warehouse_incidents").insert({
          ...fields,
          issue_key: c.issueKey,
          check_key: c.checkKey,
          organization_id: c.orgId,
          entity_id: c.entityId,
          peak_severity: c.severity,
          first_seen_at: nowIso,
        });
        // 23505: một lượt khác vừa mở cùng sự cố (index một-dòng-đang-mở).
        // Lượt sau sẽ gom vào đó — không cần làm gì thêm.
        if (error && (error as { code?: string }).code !== "23505") throw new Error(error.message);
        if (!error) summary.opened++;
      }
    } catch (err) {
      summary.errors.push(`${c.issueKey}: ${errorMessage(err)}`);
    }
  });

  // Đóng — chỉ khi có bằng chứng dương (luật 2).
  const absent = active.filter((r) => !seen.has(r.issue_key));
  await inBatches(absent, 10, async (r) => {
    const decision = decideResolution(r, input.checks);
    if (!decision.resolve) {
      summary.kept++;
      return;
    }
    try {
      const { error } = await admin
        .from("warehouse_incidents")
        .update({ status: "resolved", resolved_at: nowIso, resolved_reason: decision.reason })
        .eq("id", r.id)
        // Người trực có thể vừa đóng tay ở lượt này — đừng ghi đè.
        .in("status", ["open", "acknowledged"]);
      if (error) throw new Error(error.message);
      if (decision.reason === "auto_ok") summary.resolvedOk++;
      else summary.resolvedOutOfScope++;
    } catch (err) {
      summary.errors.push(`đóng ${r.issue_key}: ${errorMessage(err)}`);
    }
  });

  return summary;
}

// ============================================================================
// Đọc — cho trang Tình trạng. Chỉ đọc, không bao giờ ném.
// ============================================================================

export interface OpenIncident {
  id: string;
  issue_key: string;
  check_key: string;
  organization_id: string | null;
  severity: IncidentSeverity;
  peak_severity: IncidentSeverity;
  where_label: string;
  what_label: string;
  symptom: string;
  action: string;
  status: "open" | "acknowledged";
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
}

export type IncidentLedgerView =
  | { available: true; open: OpenIncident[]; totalOpen: number }
  | { available: false; reason: string };

/** Trang hiện tối đa ngần này dòng; con số tổng vẫn đúng. */
const LEDGER_PAGE_SIZE = 20;

export async function readOpenIncidents(admin: Admin): Promise<IncidentLedgerView> {
  try {
    const { data, error, count } = await admin
      .from("warehouse_incidents")
      .select(
        "id, issue_key, check_key, organization_id, severity, peak_severity, where_label, what_label, symptom, action, status, first_seen_at, last_seen_at, occurrence_count",
        { count: "exact" },
      )
      .in("status", ["open", "acknowledged"])
      // 'crit' < 'warn' theo chữ cái — tăng dần là nặng lên trước.
      .order("severity", { ascending: true })
      .order("last_seen_at", { ascending: false })
      .limit(LEDGER_PAGE_SIZE);
    if (error) {
      // Bảng chưa tồn tại: Postgres 42P01, PostgREST PGRST205. Nói thẳng là
      // chưa chạy migration, đừng để trang hiện "0 sự cố" — 0 là khoẻ, còn
      // đây là chưa có sổ.
      const code = (error as { code?: string }).code;
      if (code === "42P01" || code === "PGRST205") {
        return { available: false, reason: "Chưa có bảng sổ sự cố — cần chạy migration 20260926100000." };
      }
      return { available: false, reason: `Không đọc được sổ sự cố: ${error.message}` };
    }
    return { available: true, open: (data as OpenIncident[] | null) ?? [], totalOpen: count ?? 0 };
  } catch (err) {
    return { available: false, reason: `Không đọc được sổ sự cố: ${errorMessage(err)}` };
  }
}
