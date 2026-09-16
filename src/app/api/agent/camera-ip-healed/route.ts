import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentRequest,
} from "@/lib/warehouse/agent-auth";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";
import { recordAgentSigVersion } from "@/lib/warehouse/agent-sig-telemetry";
import { isNormalizedMac, normalizeMac } from "@/lib/camera/mac";
import { recordCameraEndpoint } from "@/lib/camera/endpoint-history";
import { invalidateCameraCaches } from "@/lib/camera/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * E.1 Bước A lớp 3 — agent báo "camera này đã đổi IP".
 *
 * Agent chỉ ĐỀ XUẤT, cloud mới là nơi ghi. Agent không có quyền ghi DB và
 * cũng không nên có: nó chạy trên máy trong kho khách, phần mềm ở đó bị
 * sửa là chuyện có thể xảy ra.
 *
 * Hàng rào chống ghi đè nhầm — cả bốn đều bắt buộc:
 *   1. HMAC agent hợp lệ (như mọi route agent khác).
 *   2. Camera phải thuộc đúng org của agent đã ký.
 *   3. Camera phải được gán cho chính agent đó (`agent_id`).
 *   4. MAC agent báo phải TRÙNG `cameras.mac_address` đang lưu.
 *
 * Hàng rào 4 là thứ quan trọng nhất và là bài học trực tiếp từ sự cố
 * 16/09: một quy trình "dọn dẹp" đã ghi đè cấu hình camera của kho Đại
 * Kim bằng camera của kho demo. Camera chưa có MAC thì KHÔNG tự phục hồi
 * được — đúng như vậy, vì không có gì để đối chiếu thì mọi việc cập nhật
 * đều là đoán.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  // Chỉ nhận RFC1918. Camera nằm trong LAN kho; IP công cộng ở đây nghĩa
  // là có gì đó sai, và chấp nhận nó sẽ khiến agent kết nối ra Internet.
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

interface HealBody {
  camera_id: string;
  ip: string;
  mac_address: string;
}

type ParseOutcome = { ok: true; body: HealBody } | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;
  const cameraId = typeof r.camera_id === "string" ? r.camera_id.trim() : "";
  if (!UUID_RE.test(cameraId)) return { ok: false, error: "camera_id_invalid" };
  const ip = typeof r.ip === "string" ? r.ip.trim() : "";
  if (!isPrivateIpv4(ip)) return { ok: false, error: "ip_invalid" };
  const mac = normalizeMac(typeof r.mac_address === "string" ? r.mac_address : null);
  if (!isNormalizedMac(mac)) return { ok: false, error: "mac_invalid" };
  return { ok: true, body: { camera_id: cameraId, ip, mac_address: mac } };
}

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) return NextResponse.json({ error: "missing_headers" }, { status: 400 });

  const rawBody = await req.text();
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = parseBody(json);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, secret, hmac_v2_enforced_at")
    .eq("code", headers.code)
    .maybeSingle();
  if (agentErr) return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "unknown_agent" }, { status: 401 });
  if (agent.status !== "active") {
    return NextResponse.json({ error: "agent_disabled" }, { status: 403 });
  }

  const verdict = await verifyAgentRequest(admin, {
    rawBody,
    method: "POST",
    canonicalPath: AGENT_API_PATHS.cameraIpHealed,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  const { data: camera, error: cameraErr } = await admin
    .from("cameras")
    .select("id, ip, mac_address, agent_id, organization_id, ip_auto_healed_count")
    .eq("id", parsed.body.camera_id)
    .eq("organization_id", agent.organization_id)
    .maybeSingle();
  if (cameraErr) return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  if (!camera) return NextResponse.json({ error: "camera_not_found" }, { status: 404 });
  if (camera.agent_id !== agent.id) {
    return NextResponse.json({ error: "camera_not_owned" }, { status: 403 });
  }
  if (!camera.mac_address) {
    return NextResponse.json({ error: "camera_has_no_mac" }, { status: 409 });
  }
  if (camera.mac_address !== parsed.body.mac_address) {
    console.warn(
      `[camera-ip-healed] TỪ CHỐI: MAC không khớp camera=${camera.id} lưu=${camera.mac_address} báo=${parsed.body.mac_address}`,
    );
    return NextResponse.json({ error: "mac_mismatch" }, { status: 409 });
  }
  if (camera.ip === parsed.body.ip) {
    return NextResponse.json({ ok: true, changed: false });
  }

  const previousIp = camera.ip;
  const { error: updateErr } = await admin
    .from("cameras")
    .update({
      ip: parsed.body.ip,
      ip_last_changed_at: new Date().toISOString(),
      // Đếm tăng dần để dashboard chỉ ra camera nào hay nhảy IP — đó là
      // camera cần đặt DHCP reservation, không phải camera hỏng. Đọc rồi
      // ghi có thể đua nếu hai tiến trình cùng báo, nhưng một camera chỉ
      // thuộc một agent nên trên thực tế không xảy ra, và lệch bộ đếm
      // cũng không ảnh hưởng nghiệp vụ.
      ip_auto_healed_count: (camera.ip_auto_healed_count ?? 0) + 1,
      probe_consecutive_fails: 0,
      probe_failing_since: null,
    })
    .eq("id", camera.id)
    .eq("organization_id", agent.organization_id)
    .eq("mac_address", parsed.body.mac_address);
  if (updateErr) {
    return NextResponse.json(
      { error: "update_failed", message: updateErr.message },
      { status: 500 },
    );
  }

  await recordCameraEndpoint({
    admin,
    organizationId: agent.organization_id,
    cameraId: camera.id,
    ip: parsed.body.ip,
    macAddress: parsed.body.mac_address,
    source: "auto_heal",
  });
  invalidateCameraCaches(agent.organization_id);

  console.warn(
    `[camera-ip-healed] camera=${camera.id} mac=${parsed.body.mac_address} ${previousIp} → ${parsed.body.ip}`,
  );
  return NextResponse.json({ ok: true, changed: true, previous_ip: previousIp });
}
