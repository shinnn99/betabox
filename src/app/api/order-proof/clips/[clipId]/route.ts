/**
 * @deprecated 2026-07-03 (Lát 3d list migration)
 *
 * Endpoint stream clip cũ: đọc `clip_path` là ổ agent local (chết trên
 * Vercel), có bridge 307 sang bucket signed URL nếu `bucket_path` có.
 *
 * UI `/dashboard/videos` đã ngừng gọi endpoint này từ 2026-07-03 —
 * PlayerModal đọc `signed_url` từ `/api/order-proof/[pe_id]/watch`
 * response (một cửa, không hai chỗ trả URL clip).
 *
 * Giữ code (không xóa ngay) — có thể còn deep-link cũ trong lịch sử
 * browser/email. Xóa sau 1-2 tuần verify prod im lặng với grep DƯƠNG
 * 0 caller ở `src/`, `warehouse-agent/`, `scripts/`.
 *
 * Nếu bạn định thêm caller mới — DỪNG. Dùng `/watch`.
 */
import { NextResponse } from "next/server";
import { stat, open } from "node:fs/promises";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import {
  clipRowIsSafe,
  getClipById,
} from "@/lib/order-proof/service";
import { BUCKET_NAME, SIGNED_URL_TTL_SECONDS } from "@/lib/watch/config";

interface RouteContext {
  params: Promise<{ clipId: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // Lát 3c bridge: nếu clip có bucket_path (đã upload cloud), redirect
  // sang signed URL bucket. Server production Vercel không đọc được
  // clip_path=D:\... của agent local. Với clip cũ chỉ có clip_path local
  // + không bucket, trả 410 kèm hướng dẫn dùng page /watch mới để
  // reconcile (page /watch tự enqueue cut+upload nếu chưa có bucket).
  if (row.bucket_path) {
    const admin = createAdminClient();
    const { data: signed, error: signedErr } = await admin.storage
      .from(BUCKET_NAME)
      .createSignedUrl(row.bucket_path, SIGNED_URL_TTL_SECONDS);
    if (signed?.signedUrl) {
      // 307 redirect để browser <video> follow tới signed URL bucket.
      return NextResponse.redirect(signed.signedUrl, 307);
    }
    // Bucket path có nhưng signed URL fail: fallback tiếp tục tới ổ
    // local (chỉ work khi server cùng máy agent). Không throw ngay.
    console.warn(
      `[clip GET] bucket_path=${row.bucket_path} signed URL failed: ${signedErr?.message}`,
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
      {
        error: "file_missing",
        message:
          "Clip chưa đồng bộ lên cloud. Vào /dashboard/videos, tìm đơn tương ứng và bấm Xem — modal sẽ tự cắt+upload lại.",
        packing_event_id: row.packing_event_id,
      },
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
