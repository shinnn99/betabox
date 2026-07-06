import { NextResponse } from "next/server";
import {
  isError,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import {
  deleteCamera,
  HasProofClipsError,
  updateCamera,
  validateCameraInput,
  type CameraInput,
} from "@/lib/camera/service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function PUT(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as
    | Partial<CameraInput & { status: "active" | "inactive" | "error" }>
    | null;
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Build partial input. Skip undefined entirely so updateCamera knows
  // which fields the caller actually touched. Empty-string password means
  // "clear stored password"; undefined password means "keep existing".
  const input: Partial<CameraInput> & {
    status?: "active" | "inactive" | "error";
  } = {};
  if (typeof body.name === "string") input.name = body.name;
  if (typeof body.camera_code === "string") input.camera_code = body.camera_code;
  if (typeof body.ip === "string") input.ip = body.ip;
  if (body.rtsp_port !== undefined) input.rtsp_port = Number(body.rtsp_port);
  if (typeof body.username === "string") input.username = body.username;
  if (typeof body.rtsp_path === "string") input.rtsp_path = body.rtsp_path;
  if (typeof body.location === "string" || body.location === null)
    input.location = body.location as string | null;
  if (body.password !== undefined) input.password = body.password as string | null;
  if (body.status === "active" || body.status === "inactive" || body.status === "error")
    input.status = body.status;

  const v = validateCameraInput(input as CameraInput, "update");
  if (v) return NextResponse.json({ error: "validation", ...v }, { status: 400 });

  try {
    const camera = await updateCamera(ctx.organizationId, id, input);
    if (!camera) {
      return NextResponse.json(
        { error: "not_found", message: "Không tìm thấy camera hoặc không có thay đổi." },
        { status: 404 },
      );
    }
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.update",
      targetType: "camera",
      targetId: id,
      metadata: {
        // never include password in audit metadata
        fields: Object.keys(input).filter((k) => k !== "password"),
        password_changed: input.password !== undefined,
      },
    });
    return NextResponse.json({ camera });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json(
        { error: "duplicate", message: "Mã camera đã tồn tại trong tổ chức." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "update_failed", message: (err as Error).message },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.archive");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  try {
    const ok = await deleteCamera(ctx.organizationId, id);
    if (!ok) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.delete",
      targetType: "camera",
      targetId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof HasProofClipsError) {
      return NextResponse.json(
        {
          error: "has_proof_clips",
          clips_count: err.clipsCount,
          message: err.message,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "delete_failed", message: (err as Error).message },
      { status: 400 },
    );
  }
}
