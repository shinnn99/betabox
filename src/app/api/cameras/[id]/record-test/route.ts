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
  recordTest,
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

  const row = await getCameraRow(ctx.organizationId, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let rtspUrl: string;
  try {
    rtspUrl = buildRtspForRow(row);
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "rtsp_unavailable",
        message: "Không dựng được URL RTSP cho camera này.",
      },
      { status: 503 },
    );
  }
  const transport = readTransport(req);
  const result = await recordTest(rtspUrl, row.camera_code, 10, { transport });
  const success = result.ok;
  const message = success
    ? "Ghi thử 10 giây thành công."
    : classifyFfmpegError(result);

  try {
    await recordTestResult(ctx.organizationId, id, {
      success,
      message,
      meta: {
        duration_ms: result.durationMs,
        file_name: result.fileName,
        file_size_bytes: result.fileSizeBytes,
        transport: result.transport_used,
        kind: "record_test",
      },
    });
  } catch {
    // best-effort
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "camera.record_test",
    targetType: "camera",
    targetId: id,
    metadata: {
      success,
      duration_ms: result.durationMs,
      file_name: result.fileName,
      file_size_bytes: result.fileSizeBytes,
      transport_requested: transport,
      transport_used: result.transport_used,
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
      file_name: result.fileName,
      file_size_bytes: result.fileSizeBytes,
      binary_missing: result.binaryMissing,
      timed_out: result.timedOut,
      transport_used: result.transport_used,
    },
    { status },
  );
}
