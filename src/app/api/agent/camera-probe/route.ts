import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent Lát 2: mỗi 30s TCP-connect RTSP port của mọi camera trong
 * desired-recording, batch report kết quả về đây. UI đọc để phân biệt
 * "Camera offline" (agent sống + probe fail) vs "Mất kết nối kho" (agent
 * chết → không probe được) — không dồn cả hai thành "Chưa rõ", vì mình
 * có `warehouse_agents.last_seen_at` để phân biệt.
 *
 * Agent PHẢI report cả ok=true và ok=false. Chỉ report khi ok sẽ khiến
 * camera vừa tắt phải chờ 90s stale mới đổi "Offline" — chậm 90s. Report
 * cả fail thì Offline hiện ngay nhịp probe kế (tối đa 30s).
 *
 * TCP connect (nhẹ, ~200ms, không đụng credential) — chỉ chứng minh
 * "IP camera nghe RTSP port". Đủ để chẩn vật-lý-on/off, không probe
 * stream (nặng, cần credential).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ProbeItem {
  camera_id: string;
  ok: boolean;
  latency_ms: number | null;
}

type ParseOutcome =
  | { ok: true; probes: ProbeItem[] }
  | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;
  const probes = r.probes;
  if (!Array.isArray(probes)) return { ok: false, error: "probes_required" };
  if (probes.length === 0) return { ok: false, error: "probes_empty" };
  if (probes.length > 100) return { ok: false, error: "too_many_probes" };

  const out: ProbeItem[] = [];
  for (const p of probes) {
    if (!p || typeof p !== "object") return { ok: false, error: "probe_invalid" };
    const x = p as Record<string, unknown>;
    const cameraId = typeof x.camera_id === "string" ? x.camera_id.trim() : "";
    if (!UUID_RE.test(cameraId)) return { ok: false, error: "camera_id_invalid" };
    const ok = x.ok === true;
    let latencyMs: number | null = null;
    if (x.latency_ms !== null && x.latency_ms !== undefined) {
      const n = Number(x.latency_ms);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: "latency_ms_invalid" };
      }
      latencyMs = Math.round(n);
    }
    out.push({ camera_id: cameraId, ok, latency_ms: latencyMs });
  }
  return { ok: true, probes: out };
}

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "missing_headers" }, { status: 400 });
  }

  const rawBody = await req.text();

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = parseBody(json);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, secret")
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

  // Multi-tenant filter: chỉ ghi vào camera thuộc org agent.
  const cameraIds = parsed.probes.map((p) => p.camera_id);
  const { data: cams } = await admin
    .from("cameras")
    .select("id")
    .in("id", cameraIds)
    .eq("organization_id", agent.organization_id);
  const allowed = new Set((cams ?? []).map((c) => c.id));

  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const p of parsed.probes) {
    if (!allowed.has(p.camera_id)) continue;
    const { error } = await admin
      .from("cameras")
      .update({
        last_probe_at: nowIso,
        last_probe_ok: p.ok,
        last_probe_latency_ms: p.latency_ms,
      })
      .eq("id", p.camera_id)
      .eq("organization_id", agent.organization_id);
    if (!error) updated++;
  }

  await admin
    .from("warehouse_agents")
    .update({ last_seen_at: nowIso })
    .eq("id", agent.id);

  return NextResponse.json({ ok: true, updated });
}
