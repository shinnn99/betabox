import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentRequest,
} from "@/lib/warehouse/agent-auth";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";
import { recordAgentSigVersion } from "@/lib/warehouse/agent-sig-telemetry";

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

  const verdict = await verifyAgentRequest(admin, {
    rawBody,
    method: "POST",
    canonicalPath: AGENT_API_PATHS.cameraProbe,
    headers,
    agentId: agent.id,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  // Multi-tenant filter: chỉ ghi vào camera thuộc org agent. Kèm
  // last_probe_ok cũ để tính consecutive_fails (chống flicker Online↔
  // Offline khi mạng kho jitter — cần 2 nhịp fail liên tiếp mới đổi
  // Offline; 1 nhịp jitter bỏ qua, giữ trạng thái cũ).
  const cameraIds = parsed.probes.map((p) => p.camera_id);
  const { data: cams } = await admin
    .from("cameras")
    .select("id, last_probe_ok, probe_consecutive_fails")
    .in("id", cameraIds)
    .eq("organization_id", agent.organization_id);
  const allowedById = new Map<
    string,
    {
      last_probe_ok: boolean | null;
      probe_consecutive_fails: number | null;
    }
  >();
  for (const c of cams ?? []) {
    allowedById.set(c.id, {
      last_probe_ok: c.last_probe_ok,
      probe_consecutive_fails: c.probe_consecutive_fails,
    });
  }

  // Đếm nhịp fail liên tiếp:
  //   - probe ok=true → reset counter về 0 và set last_probe_ok=true.
  //   - probe ok=false → tăng counter. Chỉ set last_probe_ok=false khi
  //     counter ≥ FAIL_THRESHOLD (mặc định 2). Nhịp fail đầu tiên: counter
  //     tăng nhưng last_probe_ok giữ nguyên (thường vẫn true) → UI vẫn
  //     "Online". Nhịp fail thứ 2 liên tiếp → last_probe_ok=false → UI
  //     đổi "Offline". Một nhịp ok=true giữa hai fail sẽ reset counter →
  //     không tích lũy fail rời rạc thành Offline sai.
  //
  // Vì sao debounce ở BACKEND không phải agent: agent restart mất RAM
  // state; đặt ở DB là nguồn chân lý sống, agent stateless về mặt này.
  const FAIL_THRESHOLD = Number(
    process.env.CAMERA_PROBE_FAIL_THRESHOLD ?? 2,
  );

  interface UpdateRow {
    id: string;
    last_probe_ok: boolean;
    last_probe_latency_ms: number | null;
    probe_consecutive_fails: number;
  }
  const rowsToUpsert: UpdateRow[] = [];
  for (const p of parsed.probes) {
    const current = allowedById.get(p.camera_id);
    if (!current) continue;
    let nextFails: number;
    let effectiveOk: boolean;
    if (p.ok) {
      nextFails = 0;
      effectiveOk = true;
    } else {
      nextFails = (current.probe_consecutive_fails ?? 0) + 1;
      if (nextFails >= FAIL_THRESHOLD) {
        effectiveOk = false;
      } else {
        // Chưa đủ ngưỡng — giữ nguyên last_probe_ok cũ, tăng counter.
        effectiveOk = current.last_probe_ok ?? false;
      }
    }
    rowsToUpsert.push({
      id: p.camera_id,
      last_probe_ok: effectiveOk,
      last_probe_latency_ms: p.latency_ms,
      probe_consecutive_fails: nextFails,
    });
  }
  const nowIso = new Date().toISOString();

  let updated = 0;
  if (rowsToUpsert.length > 0) {
    // Batch UPDATE qua RPC v2 — 1 round-trip cho toàn bộ probe, tenant
    // filter đã đưa vào RPC (WHERE c.organization_id = p_organization_id).
    // Caller PHẢI khai p_organization_id lấy từ HMAC-verified agent context
    // (agent.organization_id), KHÔNG lấy mù từ request body.
    //
    // Bảo vệ hai tầng:
    //   Tầng 1 (đã có): route pre-filter cameraIds qua SELECT eq(org)
    //     → rowsToUpsert chỉ chứa camera đúng org.
    //   Tầng 2 (mới): RPC v2 UPDATE ... WHERE c.organization_id = ...
    //     → dù caller build sai payload, DB vẫn từ chối.
    const { data: rpcResult, error } = await admin.rpc(
      "apply_camera_probes_v2",
      {
        p_organization_id: agent.organization_id,
        p_probes: rowsToUpsert.map((r) => ({
          id: r.id,
          last_probe_ok: r.last_probe_ok,
          last_probe_latency_ms: r.last_probe_latency_ms,
          probe_consecutive_fails: r.probe_consecutive_fails,
        })),
      },
    );

    // B1.1a: RPC error → fail request. Không âm thầm 200 với updated=0
    // (agent sẽ nghĩ probe đã ghi thành công → không retry).
    if (error) {
      console.error(
        `[camera-probe] apply_camera_probes_v2 failed agent=${agent.id} code=${error.code ?? "?"} message=${error.message}`,
      );
      return NextResponse.json(
        { error: "probe_apply_failed" },
        { status: 500 },
      );
    }

    // Parse response { requested, updated, rejected }.
    if (rpcResult && typeof rpcResult === "object") {
      const r = rpcResult as {
        requested?: number;
        updated?: number;
        rejected?: number;
      };
      updated = typeof r.updated === "number" ? r.updated : 0;
      const requested = typeof r.requested === "number" ? r.requested : rowsToUpsert.length;
      const rejected = typeof r.rejected === "number" ? r.rejected : 0;

      // B1.1a: rejected > 0 = dấu hiệu race (camera vừa move org?) hoặc
      // bug logic (pre-filter và RPC filter lệch) hoặc tấn công (payload
      // build cross-tenant). Log structured warning KHÔNG chứa camera_ids
      // (chống rò danh sách camera Org khác qua log). Không tiết lộ chi
      // tiết cho agent — response generic vẫn 200 vì tầng 1 pre-filter
      // đã đảm bảo không có camera Org khác trong payload.
      if (rejected > 0) {
        console.warn(
          `[camera-probe] rpc_reject agent=${agent.id} org=${agent.organization_id} requested=${requested} updated=${updated} rejected=${rejected}`,
        );
      }
    }
  }

  const { error: seenErr } = await admin
    .from("warehouse_agents")
    .update({ last_seen_at: nowIso })
    .eq("id", agent.id);
  if (seenErr) {
    console.warn(
      `[camera-probe] last_seen_at update failed agent=${agent.id} code=${seenErr.code ?? "?"} message=${seenErr.message}`,
    );
  }

  return NextResponse.json({ ok: true, updated });
}
