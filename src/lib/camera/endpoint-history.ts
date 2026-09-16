import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { normalizeMac } from "@/lib/camera/mac";

type Admin = ReturnType<typeof createAdminClient>;

export type EndpointSource = "manual" | "discovery" | "auto_heal";

/**
 * Ghi một dòng vào nhật ký địa chỉ của camera.
 *
 * Append-only và KHÔNG được làm hỏng thao tác chính: người dùng đổi IP
 * camera mà nhật ký ghi lỗi thì vẫn phải đổi được IP. Vì vậy hàm này nuốt
 * lỗi và chỉ log — nhật ký là dữ liệu đối soát, không phải dữ liệu chặn.
 */
export async function recordCameraEndpoint(params: {
  admin: Admin;
  organizationId: string;
  cameraId: string;
  ip: string;
  macAddress?: string | null;
  source: EndpointSource;
}): Promise<void> {
  const ip = params.ip.trim();
  if (!ip) return;
  const { error } = await params.admin.from("camera_endpoint_history").insert({
    organization_id: params.organizationId,
    camera_id: params.cameraId,
    ip,
    mac_address: normalizeMac(params.macAddress),
    source: params.source,
  });
  if (error) {
    console.warn(
      `[camera-endpoint-history] ghi thất bại camera=${params.cameraId} source=${params.source} message=${error.message}`,
    );
  }
}
