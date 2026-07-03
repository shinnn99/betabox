import "server-only";
import { rename, unlink } from "node:fs/promises";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveClipBounds } from "./clip-resolver";
import {
  cutClip,
  GOP_PAD_BEFORE_SECONDS,
  GOP_PAD_AFTER_SECONDS,
  REENCODE_RETRY_DRIFT_SECONDS,
  probeVideoCodec,
  isBrowserSafeVideoCodec,
} from "./clip-cutter";
import { clipFileFor, clipPathIsSafe } from "./clip-paths";
import {
  inFlightGet,
  inFlightSet,
  inFlightDelete,
} from "./service-locks";
import { cleanupOrphanBakClips } from "./clip-bak-cleanup";
import {
  getActiveSession,
  syncCameraFiles,
} from "@/lib/camera/recording-service";
import { readAgentLiveness } from "@/lib/watch/agent-liveness";
import { BUCKET_TTL_HOURS } from "@/lib/watch/config";

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
  // 3d list migration: agent liveness của org tại thời điểm gọi
  // (per-org theo readAgentLiveness — 1 kho 1 agent đúng thật; multi-
  // warehouse thì sai-nhẹ, xử theo cọc #6 project_camera_probe_tech_debt_cocs).
  // List dùng field này render badge "Kho offline" khi > 30s.
  agent_offline_seconds: number;
}

export interface ScanClipSummary {
  id: string;
  status: "pending" | "ready" | "failed";
  generated_at: string | null;
  // ACTUAL duration of the produced mp4 (ffprobe). This is what the user
  // sees when they play the clip.
  duration_seconds: number | null;
  // Business window duration (targetEnd - targetStart). Used by the UI
  // to show "đơn này = Ns" alongside the actual mp4 length.
  target_duration_seconds: number | null;
  // What we asked ffmpeg to cut (= target + GOP buffer for copy mode).
  // The mp4 should be close to this; if it's much smaller the cutter
  // either retried with reencode or surfaced a drift warning.
  cut_duration_seconds: number | null;
  // ISO timestamps of the business window (scan_at − pre … next/session
  // end − before_next). Kept for audit/tooling — the detail panel uses
  // the cut_* timestamps below because those match what plays.
  target_started_at: string | null;
  target_ended_at: string | null;
  // ISO timestamps of the actual video file: target ± GOP buffer (copy
  // mode) or target itself (reencode). The detail panel headlines these
  // so "Video bắt đầu / kết thúc" agree with the player and the duration.
  cut_started_at: string | null;
  cut_ended_at: string | null;
  clip_size_bytes: number | null;
  error_message: string | null;
  // True when this clip was re-encoded to H.264 so browsers can play it
  // (source was HEVC or another non-browser-safe codec). UI surfaces a
  // small badge so operators understand why this particular clip took
  // longer to generate than the others.
  transcoded_for_browser: boolean;
  // 3d list migration: cần tách "clip đã cắt" (status=ready) khỏi "clip
  // xem-ngay-được từ cloud" (bucket_uploaded_at còn TTL). Row status=ready
  // nhưng bucket null/expired → list phải hiện "Chưa lên cloud" + nút
  // [Tạo lại], KHÔNG hiện [Xem] (endpoint stream cũ sẽ 410 file_missing
  // trên Vercel serverless vì clip_path là ổ agent local).
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
    // 'superseded' rows are kept for audit but hidden from listing — the
    // active row is the latest non-superseded one for the event.
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
      params.output_codec === "h264" && params.effective_cut_mode === "reencode";
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

  // 3d list migration: 1 lookup agent liveness cho toàn list (per-org).
  // Đọc chung readAgentLiveness với /watch — cùng HÀM, không chỉ cùng
  // cột — để badge list và state /watch KHÔNG lệch ở ranh giới ngưỡng.
  const liveness = await readAgentLiveness(admin, organizationId);
  const agentOfflineSeconds = liveness.offline_duration_seconds;

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
  }));
}

/**
 * Helper cho UI: clip có xem-ngay-được từ bucket không?
 * status='ready' + bucket_path + bucket_uploaded_at còn trong TTL.
 * Đặt cạnh service để list và các endpoint khác dùng chung 1 công thức
 * TTL — cùng bài học nguồn-sự-thật-duy-nhất.
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
  // True iff the underlying query returned exactly `limit` rows. The
  // UI uses this to decide whether to show "Load more"; we deliberately
  // skip a COUNT(*) because it's expensive on large tables and the
  // forensic UX doesn't need an exact total.
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

  // Status: default is "valid OR duplicated" (everything that represents
  // a real packing attempt). Caller can narrow further.
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
    // ilike supports partial matches; for an exact lookup the dedicated
    // listScansByWaybill is still the right tool.
    q = q.ilike("waybill_code", `%${code}%`);
  }
  if (filter.warehouseId) q = q.eq("warehouse_id", filter.warehouseId);
  if (filter.stationId) q = q.eq("station_id", filter.stationId);

  const { data, error } = await q;
  if (error) throw error;

  const events = (data ?? []) as PackingJoinRow[];
  const scans = await attachClipsToEvents(organizationId, events);

  // Optional post-filter by clip status. We do it after the join
  // because PostgREST can't easily express "left join row missing"
  // through query string. Sample sizes are bounded by `limit` (max 200)
  // so this is cheap.
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

// ---------- Clip generation ----------

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
  // Lát 3c: bucket upload state
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
  // Hide 'superseded' rows from every user-visible lookup. These are
  // audit-only artefacts of a regenerate and must never be streamed back
  // to operators, even if the route forgot to gate on status='ready'.
  const { data } = await admin
    .from("order_proof_clips")
    .select(CLIP_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", clipId)
    .neq("status", "superseded")
    .maybeSingle();
  return (data as ClipRow | null) ?? null;
}

export async function getReadyClipForEvent(
  organizationId: string,
  packingEventId: string,
): Promise<ClipRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("order_proof_clips")
    .select(CLIP_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("packing_event_id", packingEventId)
    .eq("status", "ready")
    .maybeSingle();
  return (data as ClipRow | null) ?? null;
}

export interface GenerateOutcome {
  ok: boolean;
  clip?: ClipRow;
  reason?: string;
  message?: string;
}

// In-process lock: serialises generate calls per packing_event_id
// inside the current Node process. Two concurrent POSTs land on the
// same Map entry and the second await waits for the first.
//
// Why in-memory instead of pg_advisory_xact_lock?
//   * The PostgREST surface doesn't expose pg_advisory_xact_lock as an
//     RPC by default, and adding a custom wrapper just to lock would
//     be heavy ceremony for MVP.
//   * For real cross-process safety the unique partial index on
//     `status='ready'` already prevents two ready clips coexisting;
//     the race window is "two ffmpegs run, the loser's write is the
//     orphan file on disk". Acceptable risk for now.
//   * Lock is automatically released when the held Promise resolves.
// Lock state moved to service-locks.ts so clip-bak-cleanup.ts can read
// it without forming a circular import with this module (which imports
// cleanupOrphanBakClips for the post-regen sweep).

export function generateClipForEvent(opts: {
  organizationId: string;
  packingEventId: string;
  generatedBy: string;
  cutMode?: "copy" | "reencode";
}): Promise<GenerateOutcome> {
  // Coalesce concurrent calls per event.
  const key = `${opts.organizationId}:${opts.packingEventId}`;
  const existing = inFlightGet(key);
  if (existing) return existing as Promise<GenerateOutcome>;
  const p = doGenerate(opts).finally(() => inFlightDelete(key));
  inFlightSet(key, p);
  return p;
}

// Re-export for callers that still import the lock check from this
// module. The function lives in service-locks.ts.
export { isGenerateInFlightForEvent } from "./service-locks";

async function doGenerate(opts: {
  organizationId: string;
  packingEventId: string;
  generatedBy: string;
  cutMode?: "copy" | "reencode";
}): Promise<GenerateOutcome> {
  const admin = createAdminClient();

  // 1) Load the event. We need staff_id + work_session_id too so the
  // resolver can pick the right boundary for next_scan.
  const { data: event, error: evErr } = await admin
    .from("packing_events")
    .select(
      "id, organization_id, waybill_code, warehouse_id, station_id, staff_id, work_session_id, scanned_at, proof_camera_id, work_ended_at",
    )
    .eq("organization_id", opts.organizationId)
    .eq("id", opts.packingEventId)
    .maybeSingle();
  if (evErr) {
    return { ok: false, reason: "internal", message: evErr.message };
  }
  if (!event) {
    return { ok: false, reason: "not_found", message: "Không tìm thấy lần quét." };
  }

  // 2) Existing ready clip? Idempotent — return it.
  const existing = await getReadyClipForEvent(
    opts.organizationId,
    opts.packingEventId,
  );
  if (existing) return { ok: true, clip: existing };

  // 2b) Orphan pending cleanup. A row stuck in `pending` from a previous
  // crash (ffmpeg killed mid-cut, process restart, etc.) would otherwise
  // accumulate — `inFlight` is process-scoped, so by the time we reach
  // here no live worker holds the lock for this event. We delete the
  // stale row and its half-written file so the upcoming insert is clean.
  const { data: orphans } = await admin
    .from("order_proof_clips")
    .select("id, clip_path")
    .eq("organization_id", opts.organizationId)
    .eq("packing_event_id", opts.packingEventId)
    .eq("status", "pending");
  for (const o of (orphans ?? []) as Array<{ id: string; clip_path: string }>) {
    void unlink(o.clip_path).catch(() => {});
    // Belt-and-suspenders: re-assert status='pending' on the delete so a
    // concurrent regenerate that flipped this row to 'superseded' between
    // the select and delete won't lose the audit row.
    await admin
      .from("order_proof_clips")
      .delete()
      .eq("id", o.id)
      .eq("status", "pending");
  }

  // 3) Resolve bounds + camera + segment files.
  // The `beforeFileQuery` hook runs after the resolver has decided which
  // camera and window we care about, but BEFORE it queries the segment
  // table. We use that callback to walk disk for that camera over the
  // window — so a freshly-closed mp4 makes it into the DB without the
  // user having to open the "Recorded files" dialog and press sync.
  // Scoped (not a full tree walk) so this is cheap on each generate.
  const resolved = await resolveClipBounds({
    organizationId: opts.organizationId,
    packingEvent: {
      id: event.id,
      warehouse_id: event.warehouse_id,
      station_id: event.station_id,
      staff_id: event.staff_id,
      work_session_id: event.work_session_id,
      scanned_at: event.scanned_at,
      proof_camera_id: event.proof_camera_id,
      work_ended_at: event.work_ended_at,
    },
    beforeFileQuery: async ({ cameraId, clipStart, clipEnd }) => {
      const { data: cam } = await admin
        .from("cameras")
        .select("id, camera_code")
        .eq("organization_id", opts.organizationId)
        .eq("id", cameraId)
        .maybeSingle();
      if (!cam) return;
      const active = await getActiveSession(opts.organizationId, cameraId);
      await syncCameraFiles(
        opts.organizationId,
        { id: cam.id as string, camera_code: cam.camera_code as string },
        active?.id ?? null,
        { from: clipStart, to: clipEnd },
      );
    },
  });
  if (!resolved.ok || !resolved.cameraId || !resolved.files) {
    return {
      ok: false,
      reason: resolved.reason ?? "unknown",
      message: resolved.message,
    };
  }

  // 4) Decide cutMode. Caller's request wins; otherwise default 'copy'
  // but auto-upgrade to 'reencode' when any source segment is in a codec
  // that browsers can't decode in <video> (notably HEVC/H.265). This
  // prevents the "video plays 0:26/0:26 but the frame is black" failure
  // mode on Chrome/Edge/Firefox without forcing all clips through the
  // CPU-heavy H.264 encoder.
  const requestedCutMode = opts.cutMode ?? "copy";
  let cutMode: "copy" | "reencode" = requestedCutMode;
  let codecAutoUpgrade: {
    triggered: boolean;
    source_codecs: string[];
    probe_failed: boolean;
    reason: string | null;
  } = {
    triggered: false,
    source_codecs: [],
    probe_failed: false,
    reason: null,
  };
  if (requestedCutMode === "copy") {
    const probes = await Promise.all(
      resolved.files.map((f) => probeVideoCodec(f.file_path)),
    );
    const codecs = probes.map((p) => p.codec).filter((c): c is string => !!c);
    const probeFailed = probes.some((p) => !p.probed);
    const unsafe = codecs.filter((c) => !isBrowserSafeVideoCodec(c));
    codecAutoUpgrade.source_codecs = Array.from(new Set(codecs));
    codecAutoUpgrade.probe_failed = probeFailed;
    if (unsafe.length > 0) {
      cutMode = "reencode";
      codecAutoUpgrade.triggered = true;
      codecAutoUpgrade.reason = `source_codec_not_browser_compatible:${Array.from(
        new Set(unsafe),
      ).join(",")}`;
      console.log(
        `[order-proof] auto-upgrading cut_mode to reencode for event=${event.id} ` +
          `because source codec(s) ${unsafe.join(",")} are not browser-safe.`,
      );
    } else if (probeFailed && codecs.length === 0) {
      // ffprobe couldn't read ANY source file. Reencoding is the safe
      // choice — a copy on an unreadable source either fails outright
      // or produces a clip the browser also can't play. Better to burn
      // CPU than hand the operator a clip that opens to a black frame.
      cutMode = "reencode";
      codecAutoUpgrade.triggered = true;
      codecAutoUpgrade.reason = "source_codec_probe_failed";
      console.warn(
        `[order-proof] could not probe any source codec for event=${event.id}; ` +
          `defaulting to reencode for safety.`,
      );
    }
  }

  // 5) Insert a pending row up-front. The advisory lock (next step)
  // serialises concurrent triggers — but we also want a DB record of
  // the attempt even if ffmpeg crashes mid-way.
  const file = clipFileFor(event.waybill_code, event.id);
  const { data: pending, error: insErr } = await admin
    .from("order_proof_clips")
    .insert({
      organization_id: opts.organizationId,
      packing_event_id: event.id,
      waybill_code: event.waybill_code,
      camera_id: resolved.cameraId,
      clip_path: file.fullPath,
      clip_name: file.fileName,
      clip_started_at: resolved.clipStart.toISOString(),
      clip_ended_at: resolved.clipEnd.toISOString(),
      source_files: resolved.files.map((f) => ({
        id: f.id,
        file_path: f.file_path,
        started_at: f.started_at,
        ended_at: f.ended_at,
      })),
      status: "pending",
      cut_mode: cutMode,
      generation_params: {
        pre_seconds: resolved.preSeconds,
        before_next_seconds: resolved.beforeNextSeconds,
        default_post_seconds: resolved.defaultPostSeconds,
        end_reason: resolved.endReason,
        next_scan_event_id: resolved.nextScan?.id ?? null,
        next_scan_scanned_at: resolved.nextScan?.scanned_at ?? null,
        next_scan_boundary: resolved.nextScan?.boundary ?? null,
        // Populated when end_reason='session_end' — the operator's shift
        // checkout was used because no next valid scan existed.
        session_end_session_id: resolved.sessionEnd?.session_id ?? null,
        session_end_ended_at: resolved.sessionEnd?.ended_at ?? null,
        // Cut mode provenance. `requested_cut_mode` is what the caller
        // asked for; `cut_mode` (DB column) is what we actually decided
        // to use after codec auto-detection. `actual_cut_mode` is filled
        // post-cut in case the drift retry escalates copy→reencode.
        requested_cut_mode: requestedCutMode,
        codec_auto_upgrade: codecAutoUpgrade,
      },
      generated_by: opts.generatedBy,
    })
    .select(CLIP_COLUMNS)
    .single();
  if (insErr || !pending) {
    return {
      ok: false,
      reason: "internal",
      message: insErr?.message ?? "Không tạo được clip row",
    };
  }
  const pendingClip = pending as ClipRow;

  // 5) Compute target + cut windows.
  //
  //   target = business window the operator audits against (scan_at - pre
  //            … next_scan - before_next, falling back to default_post).
  //   cut    = what we hand to ffmpeg. For 'copy' it's target ± GOP pad
  //            so the keyframe-snap can't trim a moment inside target.
  //            Clamped to the available segment data — we can't seek
  //            before file0.started_at or past the last segment's end.
  const targetStart = resolved.clipStart;
  const targetEnd = resolved.clipEnd;
  const segmentsStart = new Date(resolved.files[0].started_at).getTime();
  const lastSeg = resolved.files[resolved.files.length - 1];
  const segmentsEnd = lastSeg.ended_at
    ? new Date(lastSeg.ended_at).getTime()
    : Number.POSITIVE_INFINITY;
  const padBefore = cutMode === "copy" ? GOP_PAD_BEFORE_SECONDS : 0;
  const padAfter = cutMode === "copy" ? GOP_PAD_AFTER_SECONDS : 0;
  const cutStart = new Date(
    Math.max(segmentsStart, targetStart.getTime() - padBefore * 1000),
  );
  const cutEnd = new Date(
    Math.min(segmentsEnd, targetEnd.getTime() + padAfter * 1000),
  );

  // 6) Cut. Concurrent triggers on the same event are coalesced by
  // the inFlight map at the top of this module.
  let cutResult = await cutClip({
    files: resolved.files,
    targetStart,
    targetEnd,
    cutStart,
    cutEnd,
    outputPath: file.fullPath,
    cutMode,
  });

  // 6b) Drift-driven reencode retry. Even with the GOP buffer, some
  // streams (long GOPs, broken PTS, mid-segment camera restart) can
  // still produce an mp4 shorter than the business window. When that
  // happens we re-run with -c reencode, which is frame-accurate but
  // slower. We only retry when the caller asked for 'copy' (otherwise
  // we'd loop), and only when ffprobe gave us a real duration.
  let effectiveCutMode = cutMode;
  let reencoded = false;
  if (
    cutResult.ok &&
    cutMode === "copy" &&
    !cutResult.durationProbeFailed &&
    cutResult.durationSeconds <
      cutResult.targetDurationSeconds - REENCODE_RETRY_DRIFT_SECONDS
  ) {
    console.warn(
      `[order-proof] drift too large for clip ${pendingClip.id} ` +
        `(event=${event.id}): target=${cutResult.targetDurationSeconds}s ` +
        `actual=${cutResult.durationSeconds}s. Retrying with reencode.`,
    );
    const retry = await cutClip({
      files: resolved.files,
      targetStart,
      targetEnd,
      // Reencode is frame-accurate — use the target window directly.
      cutStart: targetStart,
      cutEnd: targetEnd,
      outputPath: file.fullPath,
      cutMode: "reencode",
    });
    if (retry.ok) {
      cutResult = retry;
      effectiveCutMode = "reencode";
      reencoded = true;
    } else {
      console.warn(
        `[order-proof] reencode retry failed for clip ${pendingClip.id}, ` +
          `keeping the copy result. err=${retry.errorMessage ?? "?"}`,
      );
    }
  }

  if (!cutResult.ok) {
    await admin
      .from("order_proof_clips")
      .update({
        status: "failed",
        error_message:
          cutResult.errorMessage ?? "ffmpeg không tạo được clip.",
      })
      .eq("id", pendingClip.id);
    return {
      ok: false,
      reason: "ffmpeg_failed",
      message: cutResult.errorMessage ?? "Cắt clip thất bại.",
    };
  }

  // duration_seconds is the ACTUAL duration of the produced mp4 (read
  // via ffprobe in cutClip). We also stash the target/cut window lengths
  // in generation_params so audit can spot drift and confirm the GOP
  // buffer applied. A big gap usually means the source segments had
  // gaps or the GOP pulled the start back to a keyframe.
  //
  // If ffprobe failed we DON'T fail the generate (clip is playable),
  // but we mark `duration_probe_failed=true` so dashboards/audit can
  // flag the clip's duration as an estimate.
  if (cutResult.durationProbeFailed) {
    console.warn(
      `[order-proof] ffprobe could not read duration for clip ${pendingClip.id} ` +
        `(event=${event.id}). Falling back to cut_duration=${cutResult.cutDurationSeconds}s.`,
    );
  }
  const mergedParams = {
    ...(pendingClip.generation_params as Record<string, unknown> | null),
    target_started_at: targetStart.toISOString(),
    target_ended_at: targetEnd.toISOString(),
    target_duration_seconds: cutResult.targetDurationSeconds,
    cut_started_at: cutStart.toISOString(),
    cut_ended_at: cutEnd.toISOString(),
    cut_duration_seconds: cutResult.cutDurationSeconds,
    actual_duration_seconds: cutResult.durationProbeFailed
      ? null
      : cutResult.durationSeconds,
    gop_pad_before_seconds: padBefore,
    gop_pad_after_seconds: padAfter,
    duration_probe_failed: cutResult.durationProbeFailed,
    reencoded_due_to_drift: reencoded,
    effective_cut_mode: effectiveCutMode,
    // h264 when reencoded; otherwise the source codec passes through
    // untouched (typically h264, possibly hevc on cameras that still
    // got 'copy' because their codec was deemed browser-safe).
    output_codec:
      effectiveCutMode === "reencode"
        ? "h264"
        : codecAutoUpgrade.source_codecs[0] ?? null,
  };
  const { data: ready, error: upErr } = await admin
    .from("order_proof_clips")
    .update({
      status: "ready",
      generated_at: new Date().toISOString(),
      clip_size_bytes: cutResult.sizeBytes,
      duration_seconds: cutResult.durationSeconds,
      cut_mode: effectiveCutMode,
      generation_params: mergedParams,
    })
    .eq("id", pendingClip.id)
    .select(CLIP_COLUMNS)
    .single();
  if (upErr) {
    return { ok: false, reason: "internal", message: upErr.message };
  }
  return { ok: true, clip: ready as ClipRow };
}

// Used by stream route — same anti-traversal pattern as recording.
export function clipRowIsSafe(row: { clip_path: string }): boolean {
  return clipPathIsSafe(row.clip_path);
}

// Replace a failed/ready clip with a fresh one.
//
// We never delete the old file/row UNTIL the new clip is confirmed
// ready: an in-flight regenerate that fails halfway must not leave the
// operator with no evidence. The sequence is:
//   1. Rename existing files to `<path>.bak` (atomic on Windows/POSIX).
//   2. Mark existing rows status='superseded' so generate doesn't see
//      them as ready/pending. We keep the rows for audit.
//   3. Call generateClipForEvent.
//   4. On success: drop the superseded rows and unlink the .bak files.
//      On failure: restore .bak files, flip rows back to their previous
//      status. The caller's old clip remains usable.
export async function regenerateClipForEvent(opts: {
  organizationId: string;
  packingEventId: string;
  generatedBy: string;
  cutMode?: "copy" | "reencode";
}): Promise<GenerateOutcome> {
  const admin = createAdminClient();
  const { data: olds } = await admin
    .from("order_proof_clips")
    .select("id, clip_path, status")
    .eq("organization_id", opts.organizationId)
    .eq("packing_event_id", opts.packingEventId);

  type OldRow = { id: string; clip_path: string; status: string };
  const oldRows = (olds ?? []) as OldRow[];
  const backups: Array<{ id: string; original: string; backup: string; prevStatus: string }> = [];

  // The `[order-proof][regen]` log prefix is the marker operations should
  // grep for when a clip went missing — every step that touches files or
  // status is logged with the clip row id so manual recovery is possible.
  const logCtx = `event=${opts.packingEventId}`;

  for (const o of oldRows) {
    const backupPath = `${o.clip_path}.bak`;
    let renamed = false;
    try {
      await rename(o.clip_path, backupPath);
      renamed = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // ENOENT is expected for failed clips (no file on disk). Anything
        // else is a real I/O problem worth flagging.
        console.error(
          `[order-proof][regen] rename-to-bak failed ${logCtx} clip=${o.id} ` +
            `path=${o.clip_path}: ${(err as Error).message}`,
        );
      }
    }
    backups.push({
      id: o.id,
      original: o.clip_path,
      backup: renamed ? backupPath : "",
      prevStatus: o.status,
    });

    // Park the row so the upcoming generate doesn't treat it as ready.
    // If THIS update fails the file is already renamed to .bak but the
    // row still says 'ready' — that combination would be invisible-clip
    // for the operator. Log loudly and try to roll the rename back.
    const { error: parkErr } = await admin
      .from("order_proof_clips")
      .update({ status: "superseded" })
      .eq("id", o.id);
    if (parkErr) {
      console.error(
        `[order-proof][regen] park-row failed ${logCtx} clip=${o.id}: ${parkErr.message}`,
      );
      if (renamed) {
        try {
          await rename(backupPath, o.clip_path);
          console.error(
            `[order-proof][regen] rolled back rename ${logCtx} clip=${o.id}`,
          );
        } catch (restoreErr) {
          console.error(
            `[order-proof][regen] CRITICAL rename-rollback failed ${logCtx} ` +
              `clip=${o.id} bak=${backupPath}: ${(restoreErr as Error).message}. ` +
              "Manual recovery: rename the .bak file back to the original path.",
          );
        }
      }
      return {
        ok: false,
        reason: "internal",
        message: `Không park được clip cũ để regenerate: ${parkErr.message}`,
      };
    }
  }

  const outcome = await generateClipForEvent(opts);

  if (outcome.ok) {
    // Commit: drop old rows and remove .bak files. We log row-delete
    // errors but don't fail the outcome — the new clip is already ready
    // and visible; orphan superseded rows are a cleanup task, not a
    // correctness bug.
    for (const b of backups) {
      if (b.backup) {
        void unlink(b.backup).catch((err: NodeJS.ErrnoException) => {
          // We previously swallowed this silently. Log so the periodic
          // bak-cleanup sweep has a breadcrumb to grep when it later
          // finds the same file as an orphan.
          if (err.code !== "ENOENT") {
            console.warn(
              `[order-proof][regen] unlink-bak failed ${logCtx} clip=${b.id} ` +
                `path=${b.backup}: ${err.message}`,
            );
          }
        });
      }
      const { error: delErr } = await admin
        .from("order_proof_clips")
        .delete()
        .eq("id", b.id);
      if (delErr) {
        console.error(
          `[order-proof][regen] commit-delete failed ${logCtx} clip=${b.id}: ${delErr.message}`,
        );
      }
    }
    // Best-effort orphan sweep. Runs in background so the user response
    // isn't delayed. Failures here are logged inside the cleanup module
    // and never bubble up.
    void cleanupOrphanBakClips({ organizationId: opts.organizationId }).catch(
      (err) => {
        console.warn(
          `[order-proof][regen] opportunistic bak-cleanup failed: ${
            (err as Error).message
          }`,
        );
      },
    );
    return outcome;
  }

  // Rollback: restore .bak files and the original statuses.
  for (const b of backups) {
    if (b.backup) {
      try {
        await rename(b.backup, b.original);
      } catch (err) {
        // .bak left in place — surface clearly so ops can recover.
        console.error(
          `[order-proof][regen] CRITICAL rollback-rename failed ${logCtx} ` +
            `clip=${b.id} bak=${b.backup} target=${b.original}: ${(err as Error).message}. ` +
            "Manual recovery: rename the .bak file back to the original path.",
        );
      }
    }
    const { error: restoreErr } = await admin
      .from("order_proof_clips")
      .update({ status: b.prevStatus })
      .eq("id", b.id);
    if (restoreErr) {
      console.error(
        `[order-proof][regen] CRITICAL rollback-status failed ${logCtx} ` +
          `clip=${b.id} target_status=${b.prevStatus}: ${restoreErr.message}. ` +
          "Manual recovery: flip this row back to its previous status.",
      );
    }
  }
  return outcome;
}
