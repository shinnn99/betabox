import { NextResponse } from "next/server";
import { stat, open } from "node:fs/promises";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import {
  fileRowIsSafe,
  getFileRowById,
} from "@/lib/camera/recording-service";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

export const runtime = "nodejs";

// Parses a single-range "bytes=START-END" header. Multi-range is not
// supported (browsers don't need it for <video>). Returns null when the
// header is absent or malformed — caller falls back to a full body.
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
    // suffix range "-N": last N bytes
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
  const ctx = await requirePermission("camera.recording.view");
  if (isError(ctx)) return ctx;
  const { fileId } = await params;

  const row = await getFileRowById(ctx.organizationId, fileId);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Defense in depth: even though file_path was written by our own code,
  // refuse anything that escapes RECORDING_DIR. Stops a malicious DB
  // row (or future bug) from streaming arbitrary files.
  if (!fileRowIsSafe(row)) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  let size: number;
  try {
    const st = await stat(row.file_path);
    size = st.size;
  } catch {
    return NextResponse.json(
      { error: "file_missing", message: "File không còn trên đĩa." },
      { status: 410 },
    );
  }

  const rangeHeader = req.headers.get("range");
  const range = parseRange(rangeHeader, size);

  const fh = await open(row.file_path, "r");
  const readStart = range?.start ?? 0;
  const readEnd = range?.end ?? size - 1;
  const length = readEnd - readStart + 1;

  // We build the Web ReadableStream by hand instead of Readable.toWeb,
  // because the latter doesn't handle browser-side aborts cleanly:
  // when the user closes the video or seeks aggressively, the Web
  // stream's controller gets closed while the Node stream is still
  // pushing data, resulting in "Controller is already closed"
  // uncaughtException crashes that bring the dev server down.
  const nodeStream = fh.createReadStream({ start: readStart, end: readEnd });
  let closed = false;
  let fhClosed = false;
  const closeFh = () => {
    if (fhClosed) return;
    fhClosed = true;
    // createReadStream owns the FileHandle in its `autoClose: true` default,
    // but `nodeStream.destroy()` only schedules the close; if we never reach
    // the 'end' event (client aborted mid-stream) the underlying FD can be
    // leaked on some Node versions. Force-close defensively.
    void fh.close().catch(() => {});
  };
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
          // Controller closed by client abort — stop the file read.
          closed = true;
          nodeStream.destroy();
        }
      });
      nodeStream.on("end", () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by cancel()
          }
        }
      });
      nodeStream.on("error", (err) => {
        if (!closed) {
          closed = true;
          try {
            controller.error(err);
          } catch {
            // already closed
          }
        }
      });
      nodeStream.on("close", closeFh);
    },
    cancel() {
      // Browser navigated away / closed <video>. Tear down the read.
      closed = true;
      nodeStream.destroy();
      closeFh();
    },
  });

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    // file_name is safe to send — it's the bare basename we generated.
    "Content-Disposition": `inline; filename="${row.file_name}"`,
  });
  if (range) {
    headers.set("Content-Range", `bytes ${readStart}-${readEnd}/${size}`);
  }

  return new Response(webStream, {
    status: range ? 206 : 200,
    headers,
  });
}
