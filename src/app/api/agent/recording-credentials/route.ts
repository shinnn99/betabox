import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";
import { decryptPassword } from "@/lib/camera/crypto";
import { buildRtspUrl } from "@/lib/camera/rtsp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Trả RTSP URL đầy đủ (đã giải mã) cho danh sách camera_id — chỉ cho
 * camera thuộc org của agent (organization_id lấy từ HMAC identity,
 * KHÔNG tin body).
 *
 * Vì sao có endpoint này: agent KHÔNG lưu RTSP password xuống đĩa
 * (desired-recording.json chỉ có camera_id + session_id). Boot xong
 * agent gọi đây để lấy URL, giữ trong RAM. Nếu mất mạng lúc boot →
 * agent retry (client-side), không có credential không ghi được, thà
 * chấp nhận vậy còn hơn plaintext password trên đĩa máy khách.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  camera_ids: string[];
}

function parseBody(raw: unknown): RequestBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid_body" };
  const r = raw as Record<string, unknown>;
  const ids = r.camera_ids;
  if (!Array.isArray(ids)) return { error: "camera_ids_required" };
  if (ids.length > 100) return { error: "too_many_camera_ids" };
  for (const id of ids) {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return { error: "camera_id_invalid" };
    }
  }
  return { camera_ids: ids as string[] };
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
  if ("error" in parsed) {
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

  // Filter theo organization_id của agent — KHÔNG tin camera_ids từ client.
  // Camera không thuộc org agent thì lặng lẽ bị loại, không leak "exists".
  const { data: cams, error: camErr } = await admin
    .from("cameras")
    .select(
      "id, camera_code, ip, rtsp_port, username, password_ciphertext, password_iv, password_tag, rtsp_path",
    )
    .in("id", parsed.camera_ids)
    .eq("organization_id", agent.organization_id);

  if (camErr) {
    return NextResponse.json(
      { error: "lookup_failed", message: camErr.message },
      { status: 500 },
    );
  }

  const items = (cams ?? []).map((c) => {
    let password: string | null = null;
    if (c.password_ciphertext && c.password_iv && c.password_tag) {
      try {
        password = decryptPassword({
          ciphertext: c.password_ciphertext,
          iv: c.password_iv,
          tag: c.password_tag,
        });
      } catch {
        password = null;
      }
    }
    const rtspUrl = buildRtspUrl({
      ip: c.ip,
      port: c.rtsp_port,
      username: c.username,
      password,
      path: c.rtsp_path,
    });
    return {
      camera_id: c.id,
      camera_code: c.camera_code,
      rtsp_url: rtspUrl,
      transport: "tcp" as const,
      segment_seconds: 60,
    };
  });

  await admin
    .from("warehouse_agents")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", agent.id);

  return NextResponse.json({ ok: true, items });
}
