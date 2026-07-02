import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { BUCKET_NAME } from "@/lib/watch/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 3c: user click "Thử lại" khi state=failed hoặc upload_failed.
 *
 * WIPE SLATE (2026-07-03 update): xóa cả `agent_commands` cho pe_id
 * để bypass cooldown reconcile (60s) — không phải "bypass ngoại lệ"
 * mà là xóa cái làm cooldown kích hoạt. Retry = làm lại sạch, cooldown
 * luôn áp cho auto-poll, không có nhánh ngoại lệ. Nguyên tắc: một quy
 * tắc (cooldown), không exception.
 *
 * Xử ca command đang `taken` (agent đang chạy):
 * - Retry xóa command taken → agent cắt xong gọi command-result →
 *   backend trả 409 stale_command (WHERE status='taken' AND id=X
 *   không match) → agent log bỏ. KHÔNG mồ côi DB.
 * - File .mp4 agent vừa cắt vẫn nằm trong `_clips/{pe_id}.mp4` ổ →
 *   tick tiếp /watch enqueue cut mới → agent nhận command mới → thấy
 *   file có sẵn → sau agent-side (C) fix → gửi `done` với data probe.
 *   File tái sử dụng.
 *
 * Cọc #8 project_camera_probe_tech_debt_cocs: nếu file cũ SAI (cut
 * lỗi trước đó, không phải report fail) → tái sử dụng lặp lại lỗi.
 * Triệu chứng: user báo "bấm Thử lại vẫn ra clip lỗi/sai cũ". Khi
 * đó thêm flag `force_recut:true` vào payload. Bằng chứng 2026-07-03
 * cho phép hoãn: 0 row order_proof_clips failed; 2/59 cut_clip failed
 * đều `segments_missing_on_disk` (đã được (A) chặn ở tầng enqueue).
 */
interface RouteContext {
  params: Promise<{ pe_id: string }>;
}

export async function POST(_req: Request, ctx: RouteContext) {
  const { pe_id: packingEventId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(packingEventId)) {
    return NextResponse.json(
      { error: "packing_event_id_invalid" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: pe } = await admin
    .from("packing_events")
    .select("id, organization_id")
    .eq("id", packingEventId)
    .maybeSingle();
  if (!pe) {
    return NextResponse.json({ error: "packing_event_not_found" }, { status: 404 });
  }
  const { data: profile } = await admin
    .from("user_profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || profile.organization_id !== pe.organization_id) {
    return NextResponse.json(
      { error: "cross_org_access_denied" },
      { status: 403 },
    );
  }

  // Fetch clip để lấy bucket_path (nếu có, xóa file)
  const { data: clip } = await admin
    .from("order_proof_clips")
    .select("bucket_path")
    .eq("packing_event_id", packingEventId)
    .maybeSingle();

  // Xóa file bucket nếu có
  if (clip?.bucket_path) {
    await admin.storage.from(BUCKET_NAME).remove([clip.bucket_path]);
  }

  // Xóa row DB
  await admin
    .from("order_proof_clips")
    .delete()
    .eq("packing_event_id", packingEventId)
    .eq("organization_id", pe.organization_id);

  // WIPE SLATE — xóa cả agent_commands cho pe_id (cut_clip + upload_clip),
  // bất kể status. Bảo vệ command đang taken: xem docstring trên.
  //
  // Filter payload->>packing_event_id giống hasActiveJob/hasRecentEnqueuedCut
  // ở /watch/route.ts — cùng cột JSON path, không lệch.
  await admin
    .from("agent_commands")
    .delete()
    .eq("organization_id", pe.organization_id)
    .in("type", ["cut_clip", "upload_clip"])
    .filter("payload->>packing_event_id", "eq", packingEventId);

  return NextResponse.json({ ok: true, action: "reset_will_reprocess" });
}
