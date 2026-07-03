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

  // NTP guard: agent gửi time_drift_seconds (abs, tính từ /api/warehouse/
  // time-check). Body cũ `{ping:true}` không có field này → giữ null,
  // tương thích ngược. Body mới `{ping:true, time_drift_seconds: N}` →
  // cập nhật DB, dashboard hiện badge khi > 30.
  //
  // Trừ đi round-trip time là việc agent — backend chỉ nhận số cuối
  // (agent tự cộng/trừ RTT trước khi gửi). Đơn giản backend, tin agent
  // đã tính đúng.
  let timeDriftSeconds: number | null = null;
  try {
    const parsed = JSON.parse(rawBody) as { time_drift_seconds?: unknown };
    if (typeof parsed.time_drift_seconds === "number" && Number.isFinite(parsed.time_drift_seconds)) {
      // Clamp về [0, 999999] để tránh row DB bị số kỳ dị (agent bug).
      timeDriftSeconds = Math.min(999_999, Math.max(0, Math.round(parsed.time_drift_seconds)));
    }
  } catch {
    // Body không phải JSON hợp lệ hoặc rỗng — bỏ qua drift, vẫn update last_seen_at.
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { last_seen_at: now };
  if (timeDriftSeconds !== null) {
    updates.time_drift_seconds = timeDriftSeconds;
  }
  await admin
    .from("warehouse_agents")
    .update(updates)
    .eq("id", agent.id);

  return NextResponse.json({ ok: true, last_seen_at: now });
}
