import "server-only";
import { readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { clipsRoot, clipPathIsSafe } from "./clip-paths";
import { isGenerateInFlightForEvent } from "./service-locks";

// Orphan .bak files accumulate when regenerateClipForEvent renames the
// previous clip to <path>.mp4.bak and then either:
//   * the unlink-on-commit (line 843 in service.ts) silently fails, or
//   * the Node process crashes between rename and finalize.
//
// This module sweeps the clip directory and deletes a .bak ONLY when:
//   1. the file is older than CLIP_BAK_RETENTION_HOURS (default 24h),
//   2. a replacement clip row exists in DB with status='ready' AND
//      points to a real file on disk, for the SAME packing_event_id,
//   3. there is no in-process regenerate currently running for that
//      packing_event_id.
//
// If any condition fails, the .bak is preserved and we emit a warn log
// so ops can find it. Deletes are logged. We never delete by TTL alone:
// a .bak left from a failed rollback may be the only surviving copy of
// the previous clip and is investigation evidence.

const FILENAME_RE = /^(.+)\.mp4\.bak$/;
const DEFAULT_RETENTION_HOURS = 24;

function retentionHours(): number {
  const raw = Number(process.env.CLIP_BAK_RETENTION_HOURS);
  if (Number.isFinite(raw) && raw > 0 && raw <= 24 * 30) return raw;
  return DEFAULT_RETENTION_HOURS;
}

export interface BakCleanupReport {
  scanned: number;
  deleted: number;
  preserved_no_replacement: number;
  preserved_replacement_file_missing: number;
  preserved_too_recent: number;
  preserved_inflight: number;
  preserved_filename_unparseable: number;
  preserved_path_unsafe: number;
  errors: number;
}

const EMPTY_REPORT = (): BakCleanupReport => ({
  scanned: 0,
  deleted: 0,
  preserved_no_replacement: 0,
  preserved_replacement_file_missing: 0,
  preserved_too_recent: 0,
  preserved_inflight: 0,
  preserved_filename_unparseable: 0,
  preserved_path_unsafe: 0,
  errors: 0,
});

interface BakEntry {
  path: string;
  packingEventId: string;
  mtimeMs: number;
}

// Walk <clipsRoot>/<waybill>/<event>.mp4.bak. Two levels deep, no recursion.
async function findBakFiles(root: string): Promise<BakEntry[]> {
  const out: BakEntry[] = [];
  let waybillDirs: import("node:fs").Dirent[];
  try {
    waybillDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const w of waybillDirs) {
    if (!w.isDirectory()) continue;
    const wDir = path.join(root, w.name);
    let files: import("node:fs").Dirent[];
    try {
      files = await readdir(wDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      const m = FILENAME_RE.exec(f.name);
      if (!m) continue;
      const eventId = m[1];
      const full = path.join(wDir, f.name);
      try {
        const st = await stat(full);
        out.push({ path: full, packingEventId: eventId, mtimeMs: st.mtimeMs });
      } catch {
        // file vanished between readdir and stat — skip silently
      }
    }
  }
  return out;
}

export interface CleanupOptions {
  organizationId: string;
  // For tests / dry runs.
  dryRun?: boolean;
  // For tests: override "now" so retention math is deterministic.
  now?: number;
  // For tests: inject an alternative root and admin client so the test
  // doesn't touch production filesystem / DB.
  rootOverride?: string;
  adminOverride?: SupabaseClient;
}

// Returns a per-call report. Caller decides whether to log/audit it.
export async function cleanupOrphanBakClips(
  opts: CleanupOptions,
): Promise<BakCleanupReport> {
  const report = EMPTY_REPORT();
  const root = opts.rootOverride ?? clipsRoot();
  const bakFiles = await findBakFiles(root);
  if (bakFiles.length === 0) return report;

  const now = opts.now ?? Date.now();
  const retentionMs = retentionHours() * 60 * 60 * 1000;
  const admin = opts.adminOverride ?? createAdminClient();

  // Look up replacement candidates in a single query: every ready clip
  // for the events referenced by .bak files. Avoids per-file round trips.
  const eventIds = Array.from(new Set(bakFiles.map((b) => b.packingEventId)));
  const { data: readyRows, error: queryErr } = await admin
    .from("order_proof_clips")
    .select("id, packing_event_id, clip_path, status")
    .eq("organization_id", opts.organizationId)
    .eq("status", "ready")
    .in("packing_event_id", eventIds);
  if (queryErr) {
    console.error(
      `[order-proof][bak-cleanup] DB lookup failed: ${queryErr.message}`,
    );
    report.errors += 1;
    return report;
  }

  const readyByEvent = new Map<string, { clip_path: string }>();
  for (const r of (readyRows ?? []) as Array<{
    packing_event_id: string;
    clip_path: string;
  }>) {
    readyByEvent.set(r.packing_event_id, { clip_path: r.clip_path });
  }

  for (const bak of bakFiles) {
    report.scanned += 1;

    // Defense in depth: never touch a path outside the cleanup root.
    // In production this is recordingDir() via clipPathIsSafe. In tests
    // we use rootOverride and validate against it directly. Either way,
    // the file must live under the root the caller asked us to sweep.
    const safe = opts.rootOverride
      ? path.resolve(bak.path).startsWith(path.resolve(opts.rootOverride))
      : clipPathIsSafe(bak.path);
    if (!safe) {
      console.warn(
        `[order-proof][bak-cleanup] preserved (path unsafe): ${bak.path}`,
      );
      report.preserved_path_unsafe += 1;
      continue;
    }

    // Re-validate event id: UUID-shape so a stray file like foo.mp4.bak
    // can never accidentally trick us.
    if (!/^[0-9a-fA-F-]{36}$/.test(bak.packingEventId)) {
      console.warn(
        `[order-proof][bak-cleanup] preserved (filename unparseable): ${bak.path}`,
      );
      report.preserved_filename_unparseable += 1;
      continue;
    }

    // Condition 3: in-flight regen for this event.
    if (isGenerateInFlightForEvent(opts.organizationId, bak.packingEventId)) {
      console.warn(
        `[order-proof][bak-cleanup] preserved (regen in flight) event=${bak.packingEventId}`,
      );
      report.preserved_inflight += 1;
      continue;
    }

    // Condition 1: TTL.
    if (now - bak.mtimeMs < retentionMs) {
      report.preserved_too_recent += 1;
      continue;
    }

    // Condition 2a: replacement DB row exists with status='ready'.
    const replacement = readyByEvent.get(bak.packingEventId);
    if (!replacement) {
      console.warn(
        `[order-proof][bak-cleanup] preserved (no replacement ready clip) ` +
          `event=${bak.packingEventId} bak=${bak.path}`,
      );
      report.preserved_no_replacement += 1;
      continue;
    }

    // Condition 2b: replacement file exists on disk. Without this an
    // operator could end up with neither the .bak nor a playable clip.
    if (!existsSync(replacement.clip_path)) {
      console.warn(
        `[order-proof][bak-cleanup] preserved (replacement row exists but ` +
          `file missing on disk) event=${bak.packingEventId} ` +
          `replacement_path=${replacement.clip_path} bak=${bak.path}`,
      );
      report.preserved_replacement_file_missing += 1;
      continue;
    }

    // All conditions satisfied — safe to delete.
    if (opts.dryRun) {
      report.deleted += 1;
      continue;
    }
    try {
      await unlink(bak.path);
      report.deleted += 1;
      console.log(
        `[order-proof][bak-cleanup] deleted event=${bak.packingEventId} ` +
          `bak=${bak.path} (replacement=${replacement.clip_path})`,
      );
    } catch (err) {
      report.errors += 1;
      console.error(
        `[order-proof][bak-cleanup] unlink failed event=${bak.packingEventId} ` +
          `bak=${bak.path}: ${(err as Error).message}`,
      );
    }
  }

  return report;
}
