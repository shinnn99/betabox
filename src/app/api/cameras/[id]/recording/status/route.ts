import { NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import {
  getActiveSession,
  getLatestSession,
  markSessionStopped,
  touchHeartbeat,
} from "@/lib/camera/recording-service";
import {
  getRecording,
  isAlive,
} from "@/lib/camera/recording";
import { getCameraRow } from "@/lib/camera/service";
import { cameraRecordingDir } from "@/lib/camera/recording-paths";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

const HEALTHCHECK_SECONDS = Number(
  process.env.CAMERA_RECORDING_HEALTHCHECK_SECONDS ?? 30,
);

// Lazy health check: caller polls this endpoint (~10s). We:
//   1. Look up DB session.
//   2. Cross-check with in-memory process map.
//   3. If DB says recording but process is gone -> mark error.
//   4. Bonus liveness: peek the camera's recording dir for a file
//      modified in the last (segment*2) seconds. If nothing recent,
//      surface a soft warning (not an error — segment may still be
//      open and not yet flushed to disk).
async function newestFileMtime(dir: string): Promise<number | null> {
  if (!existsSync(dir)) return null;
  let newest = 0;
  async function walk(d: string, depth: number) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1);
      } else if (ent.name.endsWith(".mp4")) {
        try {
          const st = await stat(full);
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch {}
      }
    }
  }
  await walk(dir, 0);
  return newest > 0 ? newest : null;
}

export async function GET(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermission("camera.recording.view");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const camera = await getCameraRow(ctx.organizationId, id);
  if (!camera) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let active = await getActiveSession(ctx.organizationId, id);
  const proc = getRecording(id);

  // Reconcile. Allow a grace window after session creation before we
  // call a missing in-memory entry "lost" — the client may poll
  // /status milliseconds after /start before spawn finishes, and Next
  // dev HMR may reload the recording module mid-session without
  // killing the actual child. In both cases the next poll cycle will
  // see the real state (either ffmpeg is alive or its exit handler
  // updated the row).
  const ageMs = active ? Date.now() - new Date(active.started_at).getTime() : 0;
  const GRACE_MS = 8_000;
  if (active && !proc && ageMs > GRACE_MS) {
    await markSessionStopped(active.id, {
      errorMessage: "Recording process not found (likely backend restarted)",
    });
    active = null;
  } else if (active && proc && !isAlive(id)) {
    await markSessionStopped(active.id, {
      errorMessage:
        proc.lastStderr?.slice(-500) ?? "Process died unexpectedly",
    });
    active = null;
  } else if (active && proc) {
    // best-effort heartbeat
    void touchHeartbeat(active.id);
  }

  const latest = active ?? (await getLatestSession(ctx.organizationId, id));
  const camDir = cameraRecordingDir(camera.camera_code);
  const newestMtime = await newestFileMtime(camDir);
  let warning: string | null = null;
  if (active) {
    const ageSec = newestMtime ? (Date.now() - newestMtime) / 1000 : Infinity;
    const segS = active.segment_seconds;
    if (ageSec > Math.max(HEALTHCHECK_SECONDS, segS * 2)) {
      warning = "Không có file MP4 mới gần đây. Camera có thể ngắt kết nối.";
    }
  }

  return NextResponse.json({
    is_recording: !!active,
    pid: proc?.pid ?? null,
    started_at: proc?.startedAt?.toISOString() ?? null,
    session: latest,
    warning,
    output_dir_exists: existsSync(camDir),
    newest_file_mtime: newestMtime ? new Date(newestMtime).toISOString() : null,
    last_stderr: active && proc ? proc.lastStderr.slice(-500) : null,
  });
}
