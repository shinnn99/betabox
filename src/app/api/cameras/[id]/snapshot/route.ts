import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readFile, unlink } from "node:fs/promises";
import {
  isError,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import {
  buildRtspForRow,
  getCameraRow,
} from "@/lib/camera/service";
import {
  classifyFfmpegError,
  snapshot,
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

// Returns the JPEG bytes directly. The snapshot is captured to disk first
// (because that's how ffmpeg writes single-frame output), then read back
// and deleted so we don't accumulate stale preview images on disk. The
// caller is expected to use the response in an <img> tag.
export async function GET(req: NextRequest, { params }: RouteContext) {
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
        error: "rtsp_unavailable",
        message: "Không dựng được URL RTSP cho camera này.",
      },
      { status: 503 },
    );
  }
  const transport = readTransport(req);
  const { result, filePath } = await snapshot(rtspUrl, row.camera_code, {
    transport,
  });

  if (!result.ok || !filePath) {
    let status = 502;
    if (result.binaryMissing) status = 500;
    else if (result.timedOut) status = 504;
    return NextResponse.json(
      {
        error: "snapshot_failed",
        message: classifyFfmpegError(result),
        binary_missing: result.binaryMissing,
        timed_out: result.timedOut,
      },
      { status },
    );
  }

  try {
    const buf = await readFile(filePath);
    // Delete after read — preview, not recording. ignore error.
    void unlink(filePath).catch(() => {});
    // Buffer's underlying ArrayBuffer view may be larger than the data;
    // slice to the exact range so Response doesn't ship extra bytes.
    const body = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    );
    return new Response(body as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "Content-Length": String(buf.length),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "read_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
