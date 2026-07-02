import { NextResponse } from "next/server";
import { stat, open } from "node:fs/promises";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import {
  clipRowIsSafe,
  getClipById,
} from "@/lib/order-proof/service";

interface RouteContext {
  params: Promise<{ clipId: string }>;
}

export const runtime = "nodejs";

// Parses "bytes=START-END" / suffix "-N" / open-ended "N-". Returns
// null if absent or malformed so the handler falls back to a full body.
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end >= size ||
    start > end
  ) {
    return null;
  }
  return { start, end };
}

export async function GET(req: Request, { params }: RouteContext) {
  const ctx = await requirePermission("order_proof.view");
  if (isError(ctx)) return ctx;
  const { clipId } = await params;

  const row = await getClipById(ctx.organizationId, clipId);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "ready") {
    return NextResponse.json(
      { error: "not_ready", status: row.status },
      { status: 425 },
    );
  }
  if (!clipRowIsSafe(row)) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  let size: number;
  try {
    const st = await stat(row.clip_path);
    size = st.size;
  } catch {
    return NextResponse.json(
      { error: "file_missing", message: "File clip không còn trên đĩa." },
      { status: 410 },
    );
  }

  const range = parseRange(req.headers.get("range"), size);
  const fh = await open(row.clip_path, "r");
  const readStart = range?.start ?? 0;
  const readEnd = range?.end ?? size - 1;
  const length = readEnd - readStart + 1;

  // Same hand-rolled Web ReadableStream pattern as recording route:
  // bridges Node stream to Web stream while handling client abort
  // (seek / modal close) without uncaught "Controller is already
  // closed" errors.
  const nodeStream = fh.createReadStream({ start: readStart, end: readEnd });
  let closed = false;
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer | string) => {
        if (closed) return;
        const u8 =
          typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        try {
          controller.enqueue(u8);
        } catch {
          closed = true;
          nodeStream.destroy();
        }
      });
      nodeStream.on("end", () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      });
      nodeStream.on("error", (err) => {
        if (!closed) {
          closed = true;
          try {
            controller.error(err);
          } catch {}
        }
      });
    },
    cancel() {
      closed = true;
      nodeStream.destroy();
    },
  });

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="${row.clip_name}"`,
  });
  if (range) {
    headers.set("Content-Range", `bytes ${readStart}-${readEnd}/${size}`);
  }
  return new Response(webStream, {
    status: range ? 206 : 200,
    headers,
  });
}
