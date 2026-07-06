import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { clipPathIsSafe } from "./clip-paths";
import { readAgentLiveness } from "@/lib/watch/agent-liveness";
import { BUCKET_TTL_HOURS } from "@/lib/watch/config";

/**
 * Order-proof service — read-side only sau khi dọn luồng cũ 2026-07-07.
 *
 * Toàn bộ hàm cắt clip server-side (`generateClipForEvent`,
 * `regenerateClipForEvent`, `doGenerate`) + module phụ thuộc
 * (`clip-cutter.ts`, `service-locks.ts`, `clip-bak-cleanup.ts`) đã xoá.
 * Đường cắt hiện tại 100% qua agent (Safe Retry pipeline):
 *   /watch → enqueueCutClip → agent → clip-cut-result → clip-upload-*
 *   → RPC promote_clip_generation.
 *
 * File này chỉ giữ:
 *   - List/query clip cho dashboard.
 *   - Utility `clipRowIsSafe` / `clipBucketValid` cho stream route.
 *   - Type `ClipRow`, `ScanEventPublic`, `ScanClipSummary` shared.
 */

// ---------- Scan history ----------

export interface ScanEventPublic {
  id: string;
  waybill_code: string;
  scanned_at: string;
  status: string;
  assignment_method: string;
  timing_status: string;
  work_duration_seconds: number | null;
  station: { id: string; code: string; name: string } | null;
  warehouse: { id: string; name: string } | null;
  staff: { id: string; full_name: string; staff_code: string } | null;
  camera: { id: string; camera_code: string; name: string } | null;
  clip: ScanClipSummary | null;
  agent_offline_seconds: number;
  agent_time_drift_seconds: number | null;
}

export interface ScanClipSummary {
  id: string;
  status: "pending" | "ready" | "failed";
  generated_at: string | null;
  duration_seconds: number | null;
  target_duration_seconds: number | null;
  cut_duration_seconds: number | null;
  target_started_at: string | null;
  target_ended_at: string | null;
  cut_started_at: string | null;
  cut_ended_at: string | null;
  clip_size_bytes: number | null;
  error_message: string | null;
  transcoded_for_browser: boolean;
  bucket_path: string | null;
  bucket_uploaded_at: string | null;
}

const PACKING_COLUMNS = `
  id, waybill_code, scanned_at, status, assignment_method,
  timing_status, work_duration_seconds,
  station:packing_stations ( id, code, name ),
  warehouse:warehouses ( id, name ),
  staff:staff_profiles ( id, full_name, staff_code ),
  camera:cameras!packing_events_proof_camera_id_fkey ( id, camera_code, name )
`;

type PackingJoinRow = {
  id: string;
  waybill_code: string;
  scanned_at: string;
  status: string;
  assignment_method: string;
  timing_status: string;
  work_duration_seconds: number | null;
  station: { id: string; code: string; name: string } | { id: string; code: string; name: string }[] | null;
  warehouse: { id: string; name: string } | { id: string; name: string }[] | null;
  staff: { id: string; full_name: string; staff_code: string } | { id: string; full_name: string; staff_code: string }[] | null;
  camera: { id: string; camera_code: string; name: string } | { id: string; camera_code: string; name: string }[] | null;
};

// PostgREST returns embedded relations either as a single object or an
// array depending on cardinality detection; collapse to single.
function first<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// Attach the most-recent clip per event onto the joined rows.
async function attachClipsToEvents(
  organizationId: string,
  events: PackingJoinRow[],
): Promise<ScanEventPublic[]> {
  if (events.length === 0) return [];
  const admin = createAdminClient();
  const eventIds = events.map((e) => e.id);
  const { data: clipsData } = await admin
    .from("order_proof_clips")
    .select(
      "id, packing_event_id, status, generated_at, duration_seconds, clip_size_bytes, error_message, generation_params, created_at, bucket_path, bucket_uploaded_at",
    )
    .eq("organization_id", organizationId)
    .in("packing_event_id", eventIds)
    // 'superseded' rows: audit-only sau Safe Retry, ẩn khỏi list.
    .neq("status", "superseded")
    .order("created_at", { ascending: false });

  const clipByEvent = new Map<string, ScanClipSummary>();
  for (const c of (clipsData ?? []) as Array<{
    id: string;
    packing_event_id: string;
    status: ScanClipSummary["status"];
    generated_at: string | null;
    duration_seconds: number | null;
    clip_size_bytes: number | null;
    error_message: string | null;
    generation_params: Record<string, unknown> | null;
    bucket_path: string | null;
    bucket_uploaded_at: string | null;
  }>) {
    if (clipByEvent.has(c.packing_event_id)) continue;
    const params = c.generation_params ?? {};
    const targetDur = Number(params.target_duration_seconds);
    const cutDur = Number(params.cut_duration_seconds);
    const targetStart = params.target_started_at;
    const targetEnd = params.target_ended_at;
    const cutStart = params.cut_started_at;
    const cutEnd = params.cut_ended_at;
    const codecUpgrade = params.codec_auto_upgrade as
      | { triggered?: unknown }
      | null
      | undefined;
    const transcoded =
      codecUpgrade?.triggered === true ||
      (params.output_codec === "h264" && params.effective_cut_mode === "reencode");
    clipByEvent.set(c.packing_event_id, {
      id: c.id,
      status: c.status,
      generated_at: c.generated_at,
      duration_seconds: c.duration_seconds,
      target_duration_seconds: Number.isFinite(targetDur) ? targetDur : null,
      cut_duration_seconds: Number.isFinite(cutDur) ? cutDur : null,
      target_started_at: typeof targetStart === "string" ? targetStart : null,
      target_ended_at: typeof targetEnd === "string" ? targetEnd : null,
      cut_started_at: typeof cutStart === "string" ? cutStart : null,
      cut_ended_at: typeof cutEnd === "string" ? cutEnd : null,
      clip_size_bytes: c.clip_size_bytes,
      error_message: c.error_message,
      transcoded_for_browser: !!transcoded,
      bucket_path: c.bucket_path,
      bucket_uploaded_at: c.bucket_uploaded_at,
    });
  }

  // 1 lookup agent liveness cho toàn list (per-org). Cùng HÀM với /watch —
  // không chỉ cùng cột — để badge list và state /watch KHÔNG lệch.
  const liveness = await readAgentLiveness(admin, organizationId);
  const agentOfflineSeconds = liveness.offline_duration_seconds;
  const agentTimeDriftSeconds = liveness.time_drift_seconds;

  return events.map((e) => ({
    id: e.id,
    waybill_code: e.waybill_code,
    scanned_at: e.scanned_at,
    status: e.status,
    assignment_method: e.assignment_method,
    timing_status: e.timing_status,
    work_duration_seconds: e.work_duration_seconds,
    station: first(e.station),
    warehouse: first(e.warehouse),
    staff: first(e.staff),
    camera: first(e.camera),
    clip: clipByEvent.get(e.id) ?? null,
    agent_offline_seconds: agentOfflineSeconds,
    agent_time_drift_seconds: agentTimeDriftSeconds,
  }));
}

/**
 * Helper cho UI: clip có xem-ngay-được từ bucket không?
 * status='ready' + bucket_path + bucket_uploaded_at còn trong TTL.
 */
export function clipBucketValid(clip: ScanClipSummary | null): boolean {
  if (!clip) return false;
  if (clip.status !== "ready") return false;
  if (!clip.bucket_path || !clip.bucket_uploaded_at) return false;
  const uploadedMs = new Date(clip.bucket_uploaded_at).getTime();
  if (!Number.isFinite(uploadedMs)) return false;
  const ageMs = Date.now() - uploadedMs;
  return ageMs < BUCKET_TTL_HOURS * 3600 * 1000;
}

export async function listScansByWaybill(
  organizationId: string,
  waybillCode: string,
): Promise<ScanEventPublic[]> {
  if (!waybillCode.trim()) return [];
  const admin = createAdminClient();
  const code = waybillCode.trim().toUpperCase();
  const { data, error } = await admin
    .from("packing_events")
    .select(PACKING_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("waybill_code", code)
    .order("scanned_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return attachClipsToEvents(organizationId, (data ?? []) as PackingJoinRow[]);
}

// ---------- General listing for the forensic table ----------

export interface ListScansFilter {
  from?: Date;
  to?: Date;
  waybillCode?: string;
  warehouseId?: string;
  stationId?: string;
  // "any" | one of: valid | duplicated. Other status values
  // (no_active_session / unmapped_scanner / invalid_code) are ALWAYS
  // excluded because they don't represent a real packed order.
  scanStatus?: "any" | "valid" | "duplicated";
  // "any" | "none" (no clip row) | "ready" | "pending" | "failed".
  clipStatus?: "any" | "none" | "ready" | "pending" | "failed";
  limit?: number;
  offset?: number;
}

export interface ListScansResult {
  scans: ScanEventPublic[];
  has_more: boolean;
}

export async function listScans(
  organizationId: string,
  filter: ListScansFilter,
): Promise<ListScansResult> {
  const admin = createAdminClient();
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  const offset = Math.max(0, filter.offset ?? 0);

  let q = admin
    .from("packing_events")
    .select(PACKING_COLUMNS)
    .eq("organization_id", organizationId)
    .order("scanned_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filter.scanStatus === "valid") {
    q = q.eq("status", "valid");
  } else if (filter.scanStatus === "duplicated") {
    q = q.eq("status", "duplicated");
  } else {
    q = q.in("status", ["valid", "duplicated"]);
  }

  if (filter.from) q = q.gte("scanned_at", filter.from.toISOString());
  if (filter.to) q = q.lte("scanned_at", filter.to.toISOString());
  if (filter.waybillCode && filter.waybillCode.trim()) {
    const code = filter.waybillCode.trim().toUpperCase();
    q = q.ilike("waybill_code", `%${code}%`);
  }
  if (filter.warehouseId) q = q.eq("warehouse_id", filter.warehouseId);
  if (filter.stationId) q = q.eq("station_id", filter.stationId);

  const { data, error } = await q;
  if (error) throw error;

  const events = (data ?? []) as PackingJoinRow[];
  const scans = await attachClipsToEvents(organizationId, events);

  let filtered = scans;
  if (filter.clipStatus && filter.clipStatus !== "any") {
    filtered = scans.filter((s) => {
      if (filter.clipStatus === "none") return s.clip === null;
      return s.clip?.status === filter.clipStatus;
    });
  }

  return {
    scans: filtered,
    has_more: events.length === limit,
  };
}

// ---------- Clip lookup (for stream route) ----------

export interface ClipRow {
  id: string;
  organization_id: string;
  packing_event_id: string;
  waybill_code: string;
  camera_id: string;
  clip_path: string;
  clip_name: string;
  clip_started_at: string;
  clip_ended_at: string;
  clip_size_bytes: number | null;
  duration_seconds: number | null;
  source_files: unknown;
  status: "pending" | "ready" | "failed";
  error_message: string | null;
  cut_mode: "copy" | "reencode";
  generation_params: unknown;
  generated_by: string | null;
  generated_at: string | null;
  created_at: string;
  bucket_path: string | null;
  bucket_uploaded_at: string | null;
}

const CLIP_COLUMNS =
  "id, organization_id, packing_event_id, waybill_code, camera_id, clip_path, clip_name, clip_started_at, clip_ended_at, clip_size_bytes, duration_seconds, source_files, status, error_message, cut_mode, generation_params, generated_by, generated_at, created_at, bucket_path, bucket_uploaded_at";

export async function getClipById(
  organizationId: string,
  clipId: string,
): Promise<ClipRow | null> {
  const admin = createAdminClient();
  // Superseded rows: audit-only, ẩn khỏi user-visible lookup.
  const { data } = await admin
    .from("order_proof_clips")
    .select(CLIP_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", clipId)
    .neq("status", "superseded")
    .maybeSingle();
  return (data as ClipRow | null) ?? null;
}

// Anti-traversal check cho stream route (dùng chung pattern recording).
export function clipRowIsSafe(row: { clip_path: string }): boolean {
  return clipPathIsSafe(row.clip_path);
}
