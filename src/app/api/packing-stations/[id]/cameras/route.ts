import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { enqueueConnectCamera } from "@/lib/agent-commands/enqueue";
import { generateCameraCode } from "@/lib/camera/code-gen";
import { encryptPassword } from "@/lib/camera/crypto";
import { createCamera } from "@/lib/camera/service";
import { findCameraStation, type StationCameraRole } from "@/lib/camera/station-setup";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermissionStrict } from "@/lib/supabase/guard";
import { readAgentLiveness } from "@/lib/watch/agent-liveness";
import { normalizeMac } from "@/lib/camera/mac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function roleFrom(value: unknown): StationCameraRole | null {
  return value === "proof_primary" || value === "proof_qr" ? value : null;
}

export async function POST(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("packing_station.camera_setup");
  if (isError(ctx)) return ctx;
  const { id: stationId } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const role = roleFrom(body.role);
  const ip = typeof body.ip === "string" ? body.ip.trim() : "";
  // MAC lay tu lan quet LAN. Day la dinh danh on dinh cua camera — IP chi
  // la dia chi hien tai, DHCP doi luc nao cung duoc.
  const macAddress = normalizeMac(
    typeof body.mac_address === "string" ? body.mac_address : null,
  );
  const username = typeof body.username === "string" ? body.username.trim() : "admin";
  const password = typeof body.password === "string" ? body.password : "";
  const rtspPort = Number(body.rtsp_port ?? 554);
  if (!role || !ip || !username || !password || !Number.isInteger(rtspPort) || rtspPort < 1 || rtspPort > 65535) {
    return NextResponse.json({ error: "validation", message: "Cần IP, tài khoản, mật khẩu, port và vai trò camera hợp lệ." }, { status: 400 });
  }

  const admin = createAdminClient();
  const [{ data: station }, { data: agent }] = await Promise.all([
    admin.from("packing_stations").select("id, code, name, status").eq("organization_id", ctx.organizationId).eq("id", stationId).maybeSingle(),
    admin.from("warehouse_agents").select("id").eq("organization_id", ctx.organizationId).eq("station_id", stationId).eq("status", "active").maybeSingle(),
  ]);
  if (!station || station.status !== "active") return NextResponse.json({ error: "station_not_found" }, { status: 404 });
  if (!agent) return NextResponse.json({ error: "station_agent_required", message: "Bàn chưa có agent active." }, { status: 409 });
  const liveness = await readAgentLiveness(admin, ctx.organizationId, agent.id);
  if (liveness.is_offline) return NextResponse.json({ error: "agent_offline", message: "Agent của bàn đang offline." }, { status: 409 });

  const requestedCameraId = typeof body.camera_id === "string" ? body.camera_id.trim() : "";
  // Thu tu tra cuu co chu dinh: id (nguoi dung chon ro) -> MAC (dinh danh
  // on dinh) -> IP (chi con la phong khi database chua co cot MAC). Tra
  // theo IP truoc se nhan nham khi DHCP vua cap lai dia chi cho may khac.
  type CameraLookupRow = { id: string; camera_code: string; name: string; ip: string };
  const CAMERA_COLUMNS = "id, camera_code, name, ip";
  const orgId = ctx.organizationId;

  let existingCamera: CameraLookupRow | null = null;
  if (requestedCameraId) {
    const { data, error } = await admin
      .from("cameras")
      .select(CAMERA_COLUMNS)
      .eq("organization_id", orgId)
      .eq("id", requestedCameraId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: "camera_lookup_failed", message: error.message }, { status: 500 });
    existingCamera = data;
  } else {
    if (macAddress) {
      const { data, error } = await admin
        .from("cameras")
        .select(CAMERA_COLUMNS)
        .eq("organization_id", orgId)
        .eq("mac_address", macAddress)
        .maybeSingle();
      // Loi o day gan nhu chac chan la database chua ap migration MAC —
      // khong chan luong, roi xuong tra theo IP.
      if (!error) existingCamera = data;
    }
    if (!existingCamera) {
      const { data, error } = await admin
        .from("cameras")
        .select(CAMERA_COLUMNS)
        .eq("organization_id", orgId)
        .eq("ip", ip)
        .maybeSingle();
      if (error) return NextResponse.json({ error: "camera_lookup_failed", message: error.message }, { status: 500 });
      existingCamera = data;
    }
  }

  if (requestedCameraId && !existingCamera) return NextResponse.json({ error: "camera_not_found" }, { status: 404 });

  if (existingCamera) {
    const currentStation = await findCameraStation(ctx.organizationId, existingCamera.id);
    if (currentStation && currentStation.station_id !== stationId && body.confirm_move !== true) {
      return NextResponse.json(
        {
          error: "station_transfer_confirmation_required",
          camera_id: existingCamera.id,
          current_station: currentStation,
          target_station: { station_id: station.id, station_code: station.code, station_name: station.name },
        },
        { status: 409 },
      );
    }
  }

  let cameraId: string;
  let createdNew = false;
  if (existingCamera) {
    const encrypted = encryptPassword(password);
    const { error } = await admin
      .from("cameras")
      .update({
        ip,
        rtsp_port: rtspPort,
        username,
        password_ciphertext: encrypted.ciphertext,
        password_iv: encrypted.iv,
        password_tag: encrypted.tag,
        agent_id: agent.id,
        status: "inactive",
        ...(macAddress ? { mac_address: macAddress } : {}),
      })
      .eq("organization_id", ctx.organizationId)
      .eq("id", existingCamera.id);
    if (error) return NextResponse.json({ error: "camera_update_failed", message: error.message }, { status: 500 });
    cameraId = existingCamera.id;
  } else {
    const { data: codes } = await admin.from("cameras").select("id, camera_code").eq("organization_id", ctx.organizationId);
    const requestedCode = typeof body.camera_code === "string" ? body.camera_code.trim() : "";
    const code = requestedCode || generateCameraCode(`${station.code}_${role === "proof_qr" ? "qr" : "overview"}`, codes ?? []);
    const camera = await createCamera(
      ctx.organizationId,
      {
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : `${station.name} - ${role === "proof_qr" ? "QR" : "Toàn cảnh"}`,
        camera_code: code,
        ip,
        rtsp_port: rtspPort,
        username,
        password,
        rtsp_path: typeof body.rtsp_path === "string" && body.rtsp_path.trim() ? body.rtsp_path.trim() : "/Streaming/Channels/101",
        location: station.name,
        mac_address: macAddress,
      },
      { agentId: agent.id, status: "inactive" },
    );
    cameraId = camera.id;
    createdNew = true;
  }

  try {
    const { command_id } = await enqueueConnectCamera({
      organizationId: ctx.organizationId,
      agentId: agent.id,
      cameraId,
      stationId,
      role,
      requestedBy: ctx.userId,
      createdNew,
    });
    const onvifEndpoint = typeof body.onvif_endpoint === "string" ? body.onvif_endpoint.trim() : "";
    if (onvifEndpoint) {
      await admin.from("agent_commands").update({
        payload: {
          camera_id: cameraId,
          station_id: stationId,
          role,
          requested_by: ctx.userId,
          created_new: createdNew,
          onvif_endpoint: onvifEndpoint,
        },
      }).eq("id", command_id).eq("organization_id", ctx.organizationId);
    }
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.station.connect.enqueued",
      targetType: "camera",
      targetId: cameraId,
      metadata: { station_id: stationId, agent_id: agent.id, role, command_id },
    });
    return NextResponse.json({ status: "pending", command_id, camera_id: cameraId }, { status: 202 });
  } catch (error) {
    if (createdNew) await admin.from("cameras").delete().eq("organization_id", ctx.organizationId).eq("id", cameraId);
    return NextResponse.json({ error: "enqueue_failed", message: (error as Error).message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const ctx = await requirePermissionStrict("packing_station.camera_setup");
  if (isError(ctx)) return ctx;
  const commandId = new URL(req.url).searchParams.get("command_id");
  if (!commandId) return NextResponse.json({ error: "command_id_required" }, { status: 400 });
  const admin = createAdminClient();
  const { data: command, error } = await admin
    .from("agent_commands")
    .select("id, status, result, error")
    .eq("organization_id", ctx.organizationId)
    .eq("id", commandId)
    .eq("type", "connect_camera")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "lookup_failed", message: error.message }, { status: 500 });
  if (!command) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    status: command.status === "taken" ? "pending" : command.status,
    result: command.status === "done" ? command.result : null,
    error: command.status === "failed" ? command.error : null,
  });
}
