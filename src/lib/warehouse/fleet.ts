import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { MAX_RETURN_CLIP_DURATION_SECONDS } from "@/lib/order-proof/clip-window";
import { isMissingColumnError } from "@/lib/supabase/missing-column";
import {
  CAPABILITY,
  LATEST_AGENT_VERSION,
  compareVersions,
  diskDaysLeft,
  hasCapability,
  parseSelfReport,
  type SelfReport,
} from "@/lib/warehouse/self-report";

/**
 * Đội agent — mọi máy kho trên một màn hình (kế hoạch VAN-HANH-NHIEU-KHO,
 * đợt 7, phần 4.6): kho nào chạy bản cũ, camera nào không ghi, ổ còn mấy
 * ngày, hàng đợi, sự cố mở — không phải đóng giả vào từng tổ chức.
 */

type Admin = ReturnType<typeof createAdminClient>;

export interface FleetRow {
  id: string;
  code: string | null;
  name: string | null;
  organization_id: string;
  status: string;
  last_seen_at: string | null;
  self_report: unknown;
  self_report_at: string | null;
  agent_version: string | null;
}

const COLUMNS = "id, code, name, organization_id, status, last_seen_at, self_report, self_report_at, agent_version";
const LEGACY_COLUMNS = "id, code, name, organization_id, status, last_seen_at";

/** Đọc agent kèm bản tự khai. Chưa chạy migration 20260926130000 → như cũ, không có bản khai. */
export async function loadFleetRows(
  admin: Admin,
  opts: { orgIds?: string[]; activeOnly?: boolean } = {},
): Promise<{ rows: FleetRow[]; selfReportAvailable: boolean }> {
  const run = (columns: string) => {
    let q = admin.from("warehouse_agents").select(columns);
    if (opts.activeOnly) q = q.eq("status", "active");
    if (opts.orgIds) q = q.in("organization_id", opts.orgIds);
    return q.order("code");
  };
  const first = await run(COLUMNS);
  if (first.error && ["self_report", "agent_version"].some((c) => isMissingColumnError(first.error, c))) {
    const legacy = await run(LEGACY_COLUMNS);
    if (legacy.error) throw new Error(legacy.error.message);
    const rows = ((legacy.data as unknown as FleetRow[] | null) ?? []).map((r) => ({
      ...r,
      self_report: null,
      self_report_at: null,
      agent_version: null,
    }));
    return { rows, selfReportAvailable: false };
  }
  if (first.error) throw new Error(first.error.message);
  return { rows: (first.data as unknown as FleetRow[] | null) ?? [], selfReportAvailable: true };
}

/**
 * Trần clip kiện hoàn THỰC TẾ của từng tổ chức — 310s chỉ khi MỌI agent
 * active của tổ chức tự khai hạ được bitrate (camera có thể thuộc agent bất
 * kỳ trong đó). Dùng cho bảng Đặt / Thực dùng; máy cắt clip tự quyết theo
 * đúng agent của từng clip (`returnClipCapSeconds`). Hàm thuần.
 */
export function returnClipSecondsByOrg(rows: FleetRow[], clipMaxSeconds: number): Map<string, number> {
  const byOrg = new Map<string, FleetRow[]>();
  for (const r of rows) {
    if (r.status !== "active") continue;
    byOrg.set(r.organization_id, [...(byOrg.get(r.organization_id) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const [orgId, list] of byOrg) {
    const all = list.every((r) => hasCapability(parseSelfReport(r.self_report), CAPABILITY.adaptiveClipBitrate));
    out.set(orgId, all ? Math.max(clipMaxSeconds, MAX_RETURN_CLIP_DURATION_SECONDS) : clipMaxSeconds);
  }
  return out;
}

// ============================================================================
// Trang Đội agent
// ============================================================================

export interface FleetViewRow {
  id: string;
  code: string | null;
  name: string | null;
  orgId: string;
  orgName: string;
  status: string;
  lastSeenAt: string | null;
  /** null = bản cũ chưa biết tự khai. */
  version: string | null;
  outdated: boolean;
  reportAt: string | null;
  cameras: {
    declared: number;
    /** null = chưa tự khai. */
    recording: number | null;
    notRecording: string[];
  };
  disk: { freeGb: number; freePct: number; daysLeft: number | null } | null;
  queues: SelfReport["queues"] | null;
  lastQrSuccessAt: string | null;
  capabilities: string[];
  openIncidents: { crit: number; warn: number };
}

/** Dựng một dòng Đội agent. Hàm thuần. */
export function buildFleetViewRow(
  row: FleetRow,
  ctx: {
    orgName: string;
    /** Camera active khai cho agent này trên cloud. Agent khai theo `camera_code` hoặc id. */
    declaredCameras: Array<{ id: string; code: string | null }>;
    openIncidents: { crit: number; warn: number };
  },
): FleetViewRow {
  const report = parseSelfReport(row.self_report);
  const version = report?.version ?? row.agent_version ?? null;
  const recordingKeys = new Set((report?.cameras ?? []).filter((c) => c.recording).map((c) => c.code));
  const isRecording = (c: { id: string; code: string | null }) =>
    recordingKeys.has(c.id) || (c.code !== null && recordingKeys.has(c.code));
  const label = (c: { id: string; code: string | null }) => c.code ?? c.id.slice(0, 8);
  const disk = report?.disk
    ? {
        freeGb: Math.round((report.disk.free_bytes / 1024 ** 3) * 10) / 10,
        freePct: Math.round((report.disk.free_bytes / report.disk.total_bytes) * 1000) / 10,
        daysLeft: diskDaysLeft(report.disk),
      }
    : null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    orgId: row.organization_id,
    orgName: ctx.orgName,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    version,
    outdated: !version || compareVersions(version, LATEST_AGENT_VERSION) < 0,
    reportAt: row.self_report_at,
    cameras: {
      declared: ctx.declaredCameras.length,
      recording: report ? ctx.declaredCameras.filter(isRecording).length : null,
      notRecording: report ? ctx.declaredCameras.filter((c) => !isRecording(c)).map(label) : [],
    },
    disk,
    queues: report?.queues ?? null,
    lastQrSuccessAt: report?.last_qr_success_at ?? null,
    capabilities: report?.capabilities ?? [],
    openIncidents: ctx.openIncidents,
  };
}
