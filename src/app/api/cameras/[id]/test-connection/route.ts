import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  isError,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import {
  buildRtspForRow,
  getCameraRow,
  recordTestResult,
} from "@/lib/camera/service";
import {
  classifyFfmpegError,
  testConnection,
  type RtspTransport,
} from "@/lib/camera/ffmpeg";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

function readTransport(req: NextRequest): RtspTransport {
  const t = req.nextUrl.searchParams.get("transport");
  if (t === "tcp" || t === "udp" || t === "auto") return t;
  return "auto";
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.test");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  let row;
  try {
    row = await getCameraRow(ctx.organizationId, id);
  } catch (err) {
    return NextResponse.json(
      { error: "lookup_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
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

  const transport = readTransport(req);
  const result = await testConnection(rtspUrl, { transport });
  const success = result.ok;
  const message = success
    ? "Kết nối camera thành công."
    : classifyFfmpegError(result);

  try {
    await recordTestResult(ctx.organizationId, id, {
      success,
      message,
      meta: { duration_ms: result.durationMs, transport: result.transport_used },
    });
  } catch {
    // metadata is best-effort
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "camera.test_connection",
    targetType: "camera",
    targetId: id,
    metadata: {
      success,
      duration_ms: result.durationMs,
      transport_requested: transport,
      transport_used: result.transport_used,
    },
  });

  // Map ffmpeg failure mode to an HTTP status so monitoring/alerts can
  // distinguish "camera responded with auth error" from "we never reached
  // the camera". Body still carries `success` so the UI can rely on a
  // single field regardless of status.
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
      binary_missing: result.binaryMissing,
      timed_out: result.timedOut,
      transport_used: result.transport_used,
    },
    { status },
  );
}
