import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight liveness ping from a warehouse agent.
 *
 * The agent posts an empty (or near-empty) JSON body every ~30s so the
 * dashboard knows it's alive even when nobody is scanning. HMAC is verified
 * the same way as /api/warehouse/scans — heartbeat must NOT be a path that
 * lets unauthenticated callers forge agent presence.
 */
export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "missing_headers" }, { status: 400 });
  }

  const rawBody = await req.text();

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, status, secret")
    .eq("code", headers.code)
    .maybeSingle();

  if (agentErr) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!agent) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 401 });
  }
  if (agent.status !== "active") {
    return NextResponse.json({ error: "agent_disabled" }, { status: 403 });
  }

  const verdict = verifyAgentSignature({
    rawBody,
    headers,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  const now = new Date().toISOString();
  await admin
    .from("warehouse_agents")
    .update({ last_seen_at: now })
    .eq("id", agent.id);

  return NextResponse.json({ ok: true, last_seen_at: now });
}
