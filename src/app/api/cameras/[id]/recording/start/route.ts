// BLOCKS-GO-LIVE (Lát 2): route này VẪN spawn ffmpeg trong Next.js
// process. Song song với đó, warehouse-agent Lát 2 cũng có kênh
// start_recording qua agent_commands. Nếu ai đó bấm UI cũ để start
// camera X trong lúc agent cũng đang ghi X (do desired-recording.json
// bên agent) → 2 ffmpeg cùng ghi 1 camera, đúng bug muốn diệt.
//
// Partial unique index idx_one_active_recording_per_camera trong
// camera_recording_sessions chỉ chặn tạo session thứ hai — không chặn
// ffmpeg thứ hai nếu ffmpeg spawn trước khi tạo session (ở đây cũng
// spawn trước insertSession trong logic hiện tại).
//
// Trước khi cho staff thật dùng: hoặc DIỆT route này (chuyển UI sang
// gọi enqueueStartRecording), hoặc thêm guard kiểm agent_commands +
// desired-recording bên agent trước khi spawn. Chưa xử lý ở Lát 2 vì
// chỉ Betacom test một agent.
import { NextResponse } from "next/server";
import {
  isError,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import {
  buildRtspForRow,
  getCameraRow,
} from "@/lib/camera/service";
import {
  getActiveSession,
  insertSession,
  markSessionStopped,
} from "@/lib/camera/recording-service";
import {
  isRecording,
  startRecording,
} from "@/lib/camera/recording";
import { cameraRecordingDir } from "@/lib/camera/recording-paths";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

const DEFAULT_SEGMENT = Number(process.env.RECORDING_SEGMENT_SECONDS ?? 60);
const DEFAULT_TRANSPORT = ((): "tcp" | "udp" => {
  const v = process.env.CAMERA_RECORDING_TRANSPORT;
  return v === "udp" ? "udp" : "tcp";
})();

export async function POST(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.recording.control");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    segment_seconds?: number;
    transport?: "tcp" | "udp";
  };

  // Idempotency: if there's already an active session AND a live child,
  // surface that instead of starting a second ffmpeg.
  if (isRecording(id)) {
    const existing = await getActiveSession(ctx.organizationId, id);
    if (existing) {
      return NextResponse.json(
        {
          error: "already_recording",
          message: "Camera đang được ghi.",
          session: existing,
        },
        { status: 409 },
      );
    }
  }

  // Stale cleanup. The partial unique index
  // idx_one_active_recording_per_camera serialises the actual insert, so
  // we no longer rely on this pre-check for correctness — but the DB row
  // does need to be flipped to 'stopped' before insertSession can succeed
  // when a previous Node process died with status='recording' still set.
  // Only do this when the in-memory map agrees the process is gone;
  // otherwise we'd kill an active session being inserted by a concurrent
  // /start that hasn't populated the map yet.
  if (!isRecording(id)) {
    const stale = await getActiveSession(ctx.organizationId, id);
    if (stale) {
      await markSessionStopped(stale.id, {
        errorMessage: "Replaced by new start request",
      });
    }
  }

  const row = await getCameraRow(ctx.organizationId, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let rtspUrl: string;
  try {
    rtspUrl = buildRtspForRow(row);
  } catch (err) {
    return NextResponse.json(
      { error: "decrypt_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  const segmentSeconds = Math.max(
    5,
    Math.min(3600, Number(body.segment_seconds ?? DEFAULT_SEGMENT)),
  );
  const transport: "tcp" | "udp" =
    body.transport === "udp" ? "udp" : body.transport === "tcp" ? "tcp" : DEFAULT_TRANSPORT;

  // Reserve the DB row first so we always have something to mark error
  // against if the spawn fails. The partial unique index
  // idx_one_active_recording_per_camera serialises concurrent /start
  // requests at the DB; the loser of the race gets kind='already_active'
  // and we surface 409 instead of spinning up a second ffmpeg.
  let session;
  let alreadyActive = false;
  try {
    const result = await insertSession({
      organizationId: ctx.organizationId,
      cameraId: id,
      transport,
      segmentSeconds,
      outputDir: cameraRecordingDir(row.camera_code),
      createdBy: ctx.userId,
    });
    session = result.session;
    alreadyActive = result.kind === "already_active";
  } catch (err) {
    return NextResponse.json(
      { error: "session_insert_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  if (alreadyActive) {
    // Another concurrent /start won. Don't spawn a second ffmpeg; return
    // the winning session — matches the existing isRecording(id) early
    // exit shape so the UI sees a consistent "already_recording" 409.
    return NextResponse.json(
      {
        error: "already_recording",
        message: "Camera đang được ghi.",
        session,
      },
      { status: 409 },
    );
  }

  try {
    const { pid, outputDir } = await startRecording({
      sessionId: session.id,
      cameraId: id,
      cameraCode: row.camera_code,
      rtspUrl,
      transport,
      segmentSeconds,
      onExit: ({ code, signal, lastStderr }) => {
        // We only touch the row if it's still 'recording' — meaning the
        // stop route hasn't already marked it stopped. In that case
        // ffmpeg exited on its own (camera dropped, crash, etc.).
        //
        // Don't treat a clean exit (code 0) as an error: ffmpeg's stderr
        // tail is almost always full of benign warnings ("Timestamps are
        // unset", "Non-monotonic DTS") that would otherwise surface in
        // the UI as a recording error every time the camera reconnects.
        void (async () => {
          try {
            const cur = await getActiveSession(ctx.organizationId, id);
            if (!cur || cur.id !== session!.id) return;
            const cleanExit = code === 0 && !signal;
            if (cleanExit) {
              await markSessionStopped(session!.id);
              return;
            }
            const reason =
              code !== 0 && code !== null
                ? `ffmpeg exited code=${code}`
                : signal
                  ? `ffmpeg killed signal=${signal}`
                  : "ffmpeg exited";
            await markSessionStopped(session!.id, {
              errorMessage: `${reason}${lastStderr ? `\n${lastStderr.slice(-2000)}` : ""}`,
            });
          } catch (e) {
            console.error("[recording] onExit DB update failed", e);
          }
        })();
      },
    });

    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.recording.start",
      targetType: "camera",
      targetId: id,
      metadata: {
        session_id: session.id,
        pid,
        transport,
        segment_seconds: segmentSeconds,
      },
    });

    return NextResponse.json({
      ok: true,
      session: { ...session, output_dir: outputDir },
      pid,
    });
  } catch (err) {
    // Roll the session forward into 'error' so it's not stuck at
    // 'recording' forever.
    await markSessionStopped(session.id, {
      errorMessage: `Spawn failed: ${(err as Error).message}`,
    });
    return NextResponse.json(
      { error: "start_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
