import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserStation } from "@/lib/supabase/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const station = await getCurrentUserStation();
  if (!station) return NextResponse.json({ error: "station_not_assigned" }, { status: 403 });
  const admin = createAdminClient();
  const { data, error } = await admin.from("packing_events")
    .select("id, order_id, waybill_code, scanned_at, status, work_started_at")
    .eq("station_id", station.id).is("work_ended_at", null)
    .order("scanned_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ station, order: data ?? null });
}
