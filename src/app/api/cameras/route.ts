import { NextResponse } from "next/server";
import {
  isError,
  requirePermission,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { bindCameraToDiscoveringAgent } from "@/lib/camera/discovering-agent";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createCamera,
  listCameras,
  validateCameraInput,
  type CameraInput,
} from "@/lib/camera/service";

export const runtime = "nodejs";

export async function GET() {
  const ctx = await requirePermission("camera.view");
  if (isError(ctx)) return ctx;

  try {
    const cameras = await listCameras(ctx.organizationId);
    return NextResponse.json({ cameras });
  } catch (err) {
    return NextResponse.json(
      { error: "list_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const ctx = await requirePermissionStrict("camera.create");
  if (isError(ctx)) return ctx;

  const body = (await req.json().catch(() => null)) as Partial<CameraInput> | null;
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const input: CameraInput = {
    name: String(body.name ?? ""),
    camera_code: String(body.camera_code ?? ""),
    ip: String(body.ip ?? ""),
    rtsp_port: body.rtsp_port !== undefined ? Number(body.rtsp_port) : 554,
    username: body.username !== undefined ? String(body.username) : "admin",
    password:
      typeof body.password === "string" && body.password.length > 0
        ? body.password
        : null,
    rtsp_path:
      typeof body.rtsp_path === "string" && body.rtsp_path.length > 0
        ? body.rtsp_path
        : "/ch1/main",
    location:
      typeof body.location === "string" ? body.location : null,
    // MAC do UI gui kem khi admin chon thiet bi tu ket qua quet LAN.
    mac_address: typeof body.mac_address === "string" ? body.mac_address : null,
  };

  const v = validateCameraInput(input, "create");
  if (v) return NextResponse.json({ error: "validation", ...v }, { status: 400 });

  try {
    const created = await createCamera(ctx.organizationId, input);
    // Dang nhap camera xong la agent da quet thay no phai nhan no ngay:
    // dung duong livestream va san sang ghi hinh o nhip dong bo tiep theo,
    // khong doi toi luc gan ban.
    const agentId = await bindCameraToDiscoveringAgent(
      createAdminClient(),
      ctx.organizationId,
      created,
    );
    const camera = { ...created, agent_id: agentId };
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.create",
      targetType: "camera",
      targetId: camera.id,
      metadata: { camera_code: camera.camera_code, ip: camera.ip, agent_id: agentId },
    });
    return NextResponse.json(
      {
        camera,
        ...(agentId
          ? {}
          : {
              warning: "no_agent",
              message:
                "Đã lưu camera nhưng chưa tìm được agent nào trong cùng mạng với nó. Quét lại bằng \"Tự tìm camera\" từ máy agent của kho để agent nhận camera.",
            }),
      },
      { status: 201 },
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json(
        { error: "duplicate", message: "Mã camera đã tồn tại trong tổ chức." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "insert_failed", message: (err as Error).message },
      { status: 400 },
    );
  }
}
