import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import { listFiles } from "@/lib/camera/recording-service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

function parseDate(s: string | null): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  const ctx = await requirePermission("camera.recording.view");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const from = parseDate(req.nextUrl.searchParams.get("from"));
  const to = parseDate(req.nextUrl.searchParams.get("to"));
  const before = parseDate(req.nextUrl.searchParams.get("before"));
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 200);

  try {
    const files = await listFiles(ctx.organizationId, {
      cameraId: id,
      from,
      to,
      before,
      limit: Math.max(1, Math.min(1000, limit)),
    });
    return NextResponse.json({ files });
  } catch (err) {
    return NextResponse.json(
      { error: "list_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
