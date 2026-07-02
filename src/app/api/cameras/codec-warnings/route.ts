import { NextResponse } from "next/server";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 1.2: banner UNION 2 nguồn codec cho dashboard layout.
 *
 * Nguồn 1: cameras.codec_detected (onboard-probe) — bắt camera vừa lắp
 *   HEVC chưa recording lần nào.
 * Nguồn 2: camera_recording_sessions.codec_detected (recording-probe từ
 *   3b-2) — chỉ đọc row có status='recording' của camera (session mới
 *   nhất đang chạy) để bắt ca đổi codec giữa chừng.
 *
 * Logic banner: camera có warning nếu BẤT KỲ nguồn nào ≠ 'h264' AND
 * ≠ NULL. Tắt khi mọi nguồn có giá trị đều 'h264' (null bỏ qua).
 * Trả về mảng { camera_id, camera_code, source, codec } — có thể có
 * cùng camera 2 rows từ 2 nguồn nếu cả hai đều báo.
 */
interface WarningItem {
  camera_id: string;
  camera_code: string;
  source: "onboard" | "recording";
  codec: string;
  warning: string | null;
}

export async function GET() {
  const ctx = await requirePermission("camera.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();

  const [onboardRes, sessionRes] = await Promise.all([
    admin
      .from("cameras")
      .select("id, camera_code, codec_detected, codec_warning")
      .eq("organization_id", ctx.organizationId)
      .not("codec_detected", "is", null)
      .neq("codec_detected", "h264"),
    admin
      .from("camera_recording_sessions")
      .select("camera_id, codec_detected, codec_warning, cameras!inner(camera_code, organization_id)")
      .eq("organization_id", ctx.organizationId)
      .eq("status", "recording")
      .not("codec_detected", "is", null)
      .neq("codec_detected", "h264"),
  ]);

  const items: WarningItem[] = [];

  if (onboardRes.data) {
    for (const c of onboardRes.data) {
      items.push({
        camera_id: c.id,
        camera_code: c.camera_code,
        source: "onboard",
        codec: c.codec_detected as string,
        warning: c.codec_warning as string | null,
      });
    }
  }

  if (sessionRes.data) {
    // camera_recording_sessions có thể có nhiều row per camera (multi
    // session). Chỉ lấy 1 row per camera_id để không dup UI.
    const seen = new Set<string>();
    for (const s of sessionRes.data) {
      if (seen.has(s.camera_id)) continue;
      seen.add(s.camera_id);
      const cameras = s.cameras as unknown as { camera_code: string };
      items.push({
        camera_id: s.camera_id,
        camera_code: cameras.camera_code,
        source: "recording",
        codec: s.codec_detected as string,
        warning: s.codec_warning as string | null,
      });
    }
  }

  return NextResponse.json({ items });
}
