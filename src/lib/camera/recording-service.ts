import "server-only";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { createAdminClient } from "@/lib/supabase/admin";
import { cameraRecordingDir, parseSegmentFilename, isInsideRecordingRoot } from "./recording-paths";

export interface RecordingSession {
  id: string;
  organization_id: string;
  camera_id: string;
  status: "recording" | "stopped" | "error";
  transport: "tcp" | "udp";
  segment_seconds: number;
  output_dir: string;
  started_at: string;
  stopped_at: string | null;
  last_heartbeat_at: string | null;
  error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordingFilePublic {
  id: string;
  camera_id: string;
  recording_session_id: string | null;
  file_name: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  status: "ready" | "missing" | "corrupted";
}

// Internal row including file_path. Never returned to the client; the
// frontend gets a file_id and streams via /api/recordings/:id.
export interface RecordingFileRow extends RecordingFilePublic {
  organization_id: string;
  file_path: string;
}

const FILE_PUBLIC_COLUMNS =
  "id, camera_id, recording_session_id, file_name, started_at, ended_at, duration_seconds, file_size_bytes, status";
const FILE_ALL_COLUMNS = `${FILE_PUBLIC_COLUMNS}, organization_id, file_path`;
const SESSION_COLUMNS =
  "id, organization_id, camera_id, status, transport, segment_seconds, output_dir, started_at, stopped_at, last_heartbeat_at, error_message, created_by, created_at, updated_at";

export async function getActiveSession(
  organizationId: string,
  cameraId: string,
): Promise<RecordingSession | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("camera_recording_sessions")
    .select(SESSION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("camera_id", cameraId)
    .eq("status", "recording")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as RecordingSession | null) ?? null;
}

export async function getLatestSession(
  organizationId: string,
  cameraId: string,
): Promise<RecordingSession | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("camera_recording_sessions")
    .select(SESSION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("camera_id", cameraId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as RecordingSession | null) ?? null;
}

// Result discriminates insert-vs-coalesce so the caller can react. When
// two concurrent /start requests land in the same Node process (or
// across instances) the partial unique index
// idx_one_active_recording_per_camera (camera_id WHERE status='recording')
// lets exactly one row win. The loser sees 23505 and we coalesce — same
// race-safe pattern the scan-ingest route uses for agent_event_id
// duplicate handling.
export type InsertSessionResult =
  | { kind: "inserted"; session: RecordingSession }
  | { kind: "already_active"; session: RecordingSession };

export async function insertSession(input: {
  organizationId: string;
  cameraId: string;
  transport: "tcp" | "udp";
  segmentSeconds: number;
  outputDir: string;
  createdBy: string;
}): Promise<InsertSessionResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("camera_recording_sessions")
    .insert({
      organization_id: input.organizationId,
      camera_id: input.cameraId,
      status: "recording",
      transport: input.transport,
      segment_seconds: input.segmentSeconds,
      output_dir: input.outputDir,
      created_by: input.createdBy,
      last_heartbeat_at: new Date().toISOString(),
    })
    .select(SESSION_COLUMNS)
    .single();

  if (!error && data) {
    return { kind: "inserted", session: data as RecordingSession };
  }

  // 23505 = unique_violation. With the partial index in place this fires
  // when another worker already owns the live recording row. Fetch and
  // return the winner so the caller is idempotent.
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") {
    const existing = await getActiveSession(input.organizationId, input.cameraId);
    if (existing) {
      return { kind: "already_active", session: existing };
    }
    // 23505 without a discoverable active row means the winner row got
    // flipped to stopped/error between the insert and our re-query.
    // Surface a transient error rather than silently looping; the start
    // route can retry or report.
    throw new Error(
      "recording_session_conflict_transient: 23505 but no active session visible",
    );
  }

  throw error ?? new Error("insertSession: unknown error");
}

export async function markSessionStopped(
  sessionId: string,
  opts: { errorMessage?: string | null } = {},
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("camera_recording_sessions")
    .update({
      status: opts.errorMessage ? "error" : "stopped",
      stopped_at: new Date().toISOString(),
      error_message: opts.errorMessage ?? null,
    })
    .eq("id", sessionId);
}

// ---------- Files ----------

export interface ListFilesQuery {
  cameraId: string;
  from?: Date;
  to?: Date;
  // Keyset pagination: return rows with started_at < before. Combined
  // with the desc order this is the natural "load more" cursor — no
  // OFFSET, no stale-page risk when new files arrive between pages.
  before?: Date;
  limit?: number;
}

export async function listFiles(
  organizationId: string,
  q: ListFilesQuery,
): Promise<RecordingFilePublic[]> {
  const admin = createAdminClient();
  let query = admin
    .from("camera_recording_files")
    .select(FILE_PUBLIC_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("camera_id", q.cameraId)
    .order("started_at", { ascending: false })
    .limit(q.limit ?? 200);
  if (q.from) query = query.gte("started_at", q.from.toISOString());
  if (q.to) query = query.lte("started_at", q.to.toISOString());
  if (q.before) query = query.lt("started_at", q.before.toISOString());
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as RecordingFilePublic[];
}

export async function getFileRowById(
  organizationId: string,
  id: string,
): Promise<RecordingFileRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("camera_recording_files")
    .select(FILE_ALL_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as RecordingFileRow | null) ?? null;
}

// Walk one camera's directory tree, upsert each *.mp4 we recognize.
// "Recognize" = filename matches <camera_code>_YYYYMMDD_HHMMSS.mp4.
// Files written by ffmpeg might still be open (current segment), so we
// stat for size only — duration is filled in for closed segments only.
//
// `range` scopes the scan to days that could contain segments overlapping
// [from, to]. Used by the proof-clip pipeline so backend calls don't have
// to re-walk the whole camera tree just to refresh a 90-second window.
// When `range` is set, we DO NOT delete rows for files outside the
// scoped paths — orphan cleanup is still global but only across the
// subset we actually walked, otherwise a scoped sync would wipe every
// other day's row.
export async function syncCameraFiles(
  organizationId: string,
  camera: { id: string; camera_code: string },
  activeSessionId: string | null,
  range?: { from: Date; to: Date },
): Promise<{ scanned: number; inserted: number; updated: number; deleted: number }> {
  const rootDir = cameraRecordingDir(camera.camera_code);
  if (!existsSync(rootDir)) {
    // The folder itself is gone — purge every DB row for this camera so
    // the UI matches reality. This is the user-deleted-the-recordings
    // path: the next sync after a clean wipe should leave zero rows.
    // Scoped sync skips this purge: a missing folder for a 1-day scope
    // shouldn't drop unrelated days' rows.
    if (range) {
      return { scanned: 0, inserted: 0, updated: 0, deleted: 0 };
    }
    const admin = createAdminClient();
    const { data: deleted } = await admin
      .from("camera_recording_files")
      .delete({ count: "exact" })
      .eq("organization_id", organizationId)
      .eq("camera_id", camera.id)
      .select("id");
    return {
      scanned: 0,
      inserted: 0,
      updated: 0,
      deleted: deleted?.length ?? 0,
    };
  }

  type Found = {
    fileName: string;
    filePath: string;
    startedAt: Date;
    size: number;
    mtimeMs: number;
  };
  const found: Found[] = [];

  // For scoped scans we restrict to the Y/M/D directories that could
  // hold overlapping segments. We pad by one day on each side because a
  // segment that opened just before midnight is still filed under the
  // PREVIOUS day and may extend into the requested range.
  const dayKeys = range ? enumerateDayKeys(range.from, range.to) : null;

  // childDepth is the depth the directory we're considering would
  // become if we recurse into it: root=0, year=1, month=2, day=3.
  // Without a range we descend everything up to and including day;
  // with a range we additionally gate by which Y/M/D we care about.
  function shouldDescend(dir: string, childDepth: number): boolean {
    if (childDepth > 3) return false;
    if (!dayKeys) return true;
    const rel = path.relative(rootDir, dir);
    if (rel === "" || rel === ".") return true;
    const parts = rel.split(/[\\/]/);
    if (childDepth === 1) return dayKeys.years.has(parts[0]);
    if (childDepth === 2) return dayKeys.yearMonths.has(`${parts[0]}-${parts[1]}`);
    if (childDepth === 3) return dayKeys.yearMonthDays.has(`${parts[0]}-${parts[1]}-${parts[2]}`);
    return false;
  }

  // Recursive walk year/month/day.
  async function walk(dir: string, depth: number) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldDescend(full, depth + 1)) {
          await walk(full, depth + 1);
        }
        continue;
      }
      if (!ent.name.endsWith(".mp4")) continue;
      const parsed = parseSegmentFilename(ent.name);
      if (!parsed) continue;
      try {
        const st = await stat(full);
        found.push({
          fileName: ent.name,
          filePath: full,
          startedAt: parsed.startedAt,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // skip unreadable
      }
    }
  }
  await walk(rootDir, 0);

  if (found.length === 0) {
    // Scoped scan: missing files in this window must not erase rows
    // belonging to other windows. Bail without touching the DB.
    if (range) {
      return { scanned: 0, inserted: 0, updated: 0, deleted: 0 };
    }
    // Directory exists but contains nothing we recognize. Same logic:
    // drop stale DB rows for this camera.
    const admin = createAdminClient();
    const { data: deleted } = await admin
      .from("camera_recording_files")
      .delete({ count: "exact" })
      .eq("organization_id", organizationId)
      .eq("camera_id", camera.id)
      .select("id");
    return {
      scanned: 0,
      inserted: 0,
      updated: 0,
      deleted: deleted?.length ?? 0,
    };
  }

  // Find existing rows by file_path (unique per org).
  const admin = createAdminClient();
  const filePaths = found.map((f) => f.filePath);
  const { data: existingFull } = await admin
    .from("camera_recording_files")
    .select("id, file_path, file_size_bytes, duration_seconds, ended_at")
    .eq("organization_id", organizationId)
    .in("file_path", filePaths);

  const byPath = new Map<
    string,
    {
      id: string;
      size: number | null;
      duration: number | null;
      endedAt: string | null;
    }
  >();
  for (const r of (existingFull ?? []) as Array<{
    id: string;
    file_path: string;
    file_size_bytes: number | null;
    duration_seconds: number | null;
    ended_at: string | null;
  }>) {
    byPath.set(r.file_path, {
      id: r.id,
      size: r.file_size_bytes,
      duration: r.duration_seconds,
      endedAt: r.ended_at,
    });
  }

  let inserted = 0;
  let updated = 0;

  // Decide ended_at / duration per file:
  //   * For the newest file: if recording is active AND mtime is fresh
  //     (< 15s ago), treat as still being written — keep NULL.
  //   * Otherwise the file is closed. Duration = mtime - startedAt.
  //     mtime is set by ffmpeg when it finalises the segment, so this
  //     matches actual content length even when recording was stopped
  //     mid-segment or there's a gap before the next segment.
  //
  // We DO NOT use `next.startedAt - this.startedAt` as the duration:
  // that assumes recording is continuous, which breaks the moment the
  // user pauses/restarts the recording. The resulting "duration" would
  // then include the gap, which the player can't seek into.
  //
  // As a defensive cap, we still take min(mtime, next.startedAt) for
  // ended_at — if mtime got touched after close (rare, but possible if
  // the file was post-processed), we'd otherwise overstate length.
  const sorted = [...found].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const lastIdx = sorted.length - 1;
  const now = Date.now();
  const STILL_OPEN_MS = 15_000;

  const toInsert: Array<Record<string, unknown>> = [];
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    const next = sorted[i + 1];
    let endedAt: Date | null = null;
    const isNewest = i === lastIdx;
    const stillOpen =
      isNewest &&
      activeSessionId !== null &&
      now - f.mtimeMs < STILL_OPEN_MS;
    if (!stillOpen) {
      let end = f.mtimeMs;
      if (next && next.startedAt.getTime() < end) {
        end = next.startedAt.getTime();
      }
      endedAt = new Date(end);
    }
    const duration = endedAt
      ? Math.max(0, Math.round((endedAt.getTime() - f.startedAt.getTime()) / 1000))
      : null;

    const known = byPath.get(f.filePath);
    if (known) {
      // Update when size grew (still being written) OR when duration
      // can now be filled in (segment closed since last sync).
      const newEndedIso = endedAt ? endedAt.toISOString() : null;
      const changed =
        known.size !== f.size ||
        known.duration !== duration ||
        known.endedAt !== newEndedIso;
      if (changed) {
        const { error } = await admin
          .from("camera_recording_files")
          .update({
            file_size_bytes: f.size,
            ended_at: newEndedIso,
            duration_seconds: duration,
          })
          .eq("id", known.id);
        if (!error) updated += 1;
      }
    } else {
      // BLOCKS-GO-LIVE (Lát 3a-1): source='legacy_nextjs' để 3a-2
      // resolve chỉ đọc row do agent ghi (source='agent'), không lẫn
      // với đường cũ. Trước khi go-live: hoặc diệt hẳn route/service
      // cũ (đường ghi lẫn đường cắt cũ), hoặc chấp nhận rằng row
      // legacy sẽ KHÔNG được clip-resolver 3a-2 dùng.
      toInsert.push({
        organization_id: organizationId,
        camera_id: camera.id,
        recording_session_id: activeSessionId,
        file_path: f.filePath,
        file_name: f.fileName,
        started_at: f.startedAt.toISOString(),
        ended_at: endedAt ? endedAt.toISOString() : null,
        duration_seconds: duration,
        file_size_bytes: f.size,
        status: "ready",
        source: "legacy_nextjs",
      });
    }
  }

  if (toInsert.length > 0) {
    const { error } = await admin
      .from("camera_recording_files")
      .insert(toInsert);
    if (error) throw error;
    inserted = toInsert.length;
  }

  // Drop DB rows whose file is no longer on disk. For a full sync we
  // compare against every row for this camera; for a scoped sync we
  // only consider rows whose started_at falls inside the requested
  // window — otherwise a scoped sync would orphan-delete unrelated days.
  const foundPathSet = new Set(filePaths);
  let allRowsQuery = admin
    .from("camera_recording_files")
    .select("id, file_path, started_at")
    .eq("organization_id", organizationId)
    .eq("camera_id", camera.id);
  if (range) {
    allRowsQuery = allRowsQuery
      .gte("started_at", range.from.toISOString())
      .lte("started_at", range.to.toISOString());
  }
  const { data: allRows } = await allRowsQuery;
  const orphanIds = (allRows ?? [])
    .filter((r) => !foundPathSet.has(r.file_path as string))
    .map((r) => r.id as string);
  let deleted = 0;
  if (orphanIds.length > 0) {
    const { data: del } = await admin
      .from("camera_recording_files")
      .delete({ count: "exact" })
      .in("id", orphanIds)
      .select("id");
    deleted = del?.length ?? 0;
  }

  return { scanned: found.length, inserted, updated, deleted };
}

// Helper for scoped sync: enumerate the Y/M/D directory names that
// could plausibly contain segments overlapping [from, to]. We pad by
// one day on each side to catch segments that opened just before
// midnight under the previous day's folder.
function enumerateDayKeys(from: Date, to: Date): {
  years: Set<string>;
  yearMonths: Set<string>;
  yearMonthDays: Set<string>;
} {
  const years = new Set<string>();
  const yearMonths = new Set<string>();
  const yearMonthDays = new Set<string>();
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    const y = String(cur.getFullYear());
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    years.add(y);
    yearMonths.add(`${y}-${m}`);
    yearMonthDays.add(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return { years, yearMonths, yearMonthDays };
}

// Wraps isInsideRecordingRoot to keep the import in routes minimal.
export function fileRowIsSafe(row: RecordingFileRow): boolean {
  return isInsideRecordingRoot(row.file_path);
}
