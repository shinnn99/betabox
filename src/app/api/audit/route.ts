import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission, isError } from "@/lib/supabase/guard";

export async function GET(req: Request) {
  const ctx = await requirePermission("audit.view");
  if (isError(ctx)) return ctx;

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, actor_user_id, actor_email, action, target_type, target_id, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ logs: data ?? [] });
}
