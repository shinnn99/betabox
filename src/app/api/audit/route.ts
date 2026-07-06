import { NextResponse } from "next/server";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { getScopedClient } from "@/lib/supabase/scoped-client";

export async function GET(req: Request) {
  const ctx = await requirePermission("audit.view");
  if (isError(ctx)) return ctx;

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);

  const scoped = await getScopedClient(ctx);
  const { data, error } = await scoped
    .select("audit_logs", "id, actor_user_id, actor_email, action, target_type, target_id, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ logs: data ?? [] });
}
