import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decryptPassword } from "@/lib/camera/crypto";
import { buildRtspUrl } from "@/lib/camera/rtsp";

type Admin = ReturnType<typeof createAdminClient>;

export interface CameraCredentialItem {
  camera_id: string;
  camera_code: string;
  rtsp_url: string;
  transport: "tcp";
  segment_seconds: number;
}

/**
 * Credential (RTSP URL đã giải mã) của camera trong MỘT org.
 *
 * `cameraIds = null` → mọi camera `status='active'` của org.
 *
 * `status='active'` áp cho CẢ HAI nhánh (2026-08-05). Trước đây nhánh
 * camera_ids trả credential bất kể status → bấm "Tạm ngưng" trên dashboard
 * không hề tới được agent: agent vẫn xin được credential, boot() vẫn thấy
 * camera trong response nên giữ desired, và long-retry vẫn spawn ffmpeg mỗi
 * 5 phút. Ca cắn thật: hik_01 kho Đại Kim bị tạm ngưng 31/07 nhưng vẫn bị
 * thử ghi tới 05/08 (~78 lần/ngày), và người dùng KHÔNG có đường nào dừng
 * qua UI vì cloud tin là camera không ghi.
 *
 * Response thiếu camera = thu hồi ý định ghi, agent phải xóa desired. Đây là
 * hợp đồng giữa hai bên — xem `syncDesiredWithActiveCameras` và nhánh
 * `!cred` trong long-retry ở recording-lifecycle.ts.
 *
 * Caller PHẢI truyền orgId lấy từ HMAC identity của agent, KHÔNG lấy từ body.
 */
export async function listCameraCredentials(
  admin: Admin,
  orgId: string,
  cameraIds: string[] | null,
): Promise<{ items: CameraCredentialItem[] } | { error: string }> {
  let camsQuery = admin
    .from("cameras")
    .select(
      "id, camera_code, ip, rtsp_port, username, password_ciphertext, password_iv, password_tag, rtsp_path",
    )
    .eq("organization_id", orgId)
    .eq("status", "active");
  if (cameraIds !== null) camsQuery = camsQuery.in("id", cameraIds);

  const { data: cams, error } = await camsQuery;
  if (error) return { error: error.message };

  const items = (cams ?? []).map((c) => {
    let password: string | null = null;
    if (c.password_ciphertext && c.password_iv && c.password_tag) {
      try {
        password = decryptPassword({
          ciphertext: c.password_ciphertext,
          iv: c.password_iv,
          tag: c.password_tag,
        });
      } catch {
        password = null;
      }
    }
    const rtspUrl = buildRtspUrl({
      ip: c.ip,
      port: c.rtsp_port,
      username: c.username,
      password,
      path: c.rtsp_path,
    });
    return {
      camera_id: c.id,
      camera_code: c.camera_code,
      rtsp_url: rtspUrl,
      transport: "tcp" as const,
      segment_seconds: 60,
    };
  });

  return { items };
}
