import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isError, requirePermissionStrict } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { buildRtspUrl } from "@/lib/camera/rtsp";
import {
  classifyFfmpegError,
  testConnection,
  type RtspTransport,
} from "@/lib/camera/ffmpeg";

export const runtime = "nodejs";

// Test an RTSP camera configuration that has NOT been persisted yet.
//
// Used by the "Tự tìm camera" flow: after the user picks a discovered IP
// and fills in credentials + path, we run a probe before inserting the
// row. On failure the camera is never written to the DB so we don't leave
// dangling unverified entries.
//
// Security: the request body holds a plaintext password. It is used to
// build the in-memory RTSP URL, passed straight to ffmpeg, and discarded
// at the end of the request. No DB write, no logging, no echo in the
// response. The masked URL in ffmpeg logs follows the same rules as the
// existing test-connection route.

interface TestDraftBody {
  ip?: unknown;
  rtsp_port?: unknown;
  username?: unknown;
  password?: unknown;
  rtsp_path?: unknown;
  transport?: unknown;
}

function readTransport(v: unknown): RtspTransport {
  if (v === "tcp" || v === "udp" || v === "auto") return v;
  return "auto";
}

export async function POST(req: NextRequest) {
  const ctx = await requirePermissionStrict("camera.test");
  if (isError(ctx)) return ctx;

  const body = (await req.json().catch(() => null)) as TestDraftBody | null;
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const ip = typeof body.ip === "string" ? body.ip.trim() : "";
  const port =
    typeof body.rtsp_port === "number"
      ? body.rtsp_port
      : Number(body.rtsp_port ?? 554);
  const username =
    typeof body.username === "string" && body.username.trim()
      ? body.username.trim()
      : "admin";
  const password =
    typeof body.password === "string" && body.password.length > 0
      ? body.password
      : null;
  const rtspPath =
    typeof body.rtsp_path === "string" && body.rtsp_path.trim()
      ? body.rtsp_path.trim()
      : "/ch1/main";

  if (!ip) {
    return NextResponse.json(
      { error: "validation", field: "ip", message: "IP không hợp lệ." },
      { status: 400 },
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json(
      { error: "validation", field: "rtsp_port", message: "Port phải nằm trong 1..65535." },
      { status: 400 },
    );
  }

  const rtspUrl = buildRtspUrl({
    ip,
    port,
    username,
    password,
    path: rtspPath,
  });

  const transport = readTransport(body.transport);
  const result = await testConnection(rtspUrl, { transport });
  const success = result.ok;
  const message = success
    ? "Kết nối camera thành công."
    : classifyFfmpegError(result);

  // Audit the attempt without the password. ip + path are useful for
  // post-mortem ("why did this camera not save?") and already appear on
  // every successful POST /api/cameras anyway.
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "camera.test_draft",
    targetType: "camera",
    metadata: {
      success,
      ip,
      rtsp_port: port,
      rtsp_path: rtspPath,
      transport_requested: transport,
      transport_used: result.transport_used,
      duration_ms: result.durationMs,
    },
  });

  let status = 200;
  if (!success) {
    if (result.binaryMissing) status = 500;
    else if (result.timedOut) status = 504;
    else status = 502;
  }

  return NextResponse.json(
    {
      success,
      message,
      duration_ms: result.durationMs,
      transport_used: result.transport_used,
      binary_missing: result.binaryMissing,
      timed_out: result.timedOut,
    },
    { status },
  );
}
