import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { BUCKET_NAME } from "@/lib/watch/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 3c: user click "Thử lại" khi state=failed hoặc upload_failed.
 *
 * Xóa row order_proof_clips + xóa file bucket (nếu có) → reconcile
 * tick kế sẽ thấy unknown → enqueue cut lại. User-driven, không
 * auto-retry server-side.
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

  return NextResponse.json({ ok: true, action: "reset_will_reprocess" });
}
