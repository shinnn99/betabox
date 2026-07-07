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
 * Agent báo kết quả job (done|failed) sau khi xử lý.
 *
 * Điều kiện đóng job: job đang 'taken' và agent_id của job trùng agent
 * đã xác thực HMAC. Nếu reaper đã kéo job về 'pending' trong lúc agent
 * xử lý (agent chậm hơn visibility timeout) → job không còn ở 'taken'
 * nữa → trả 409 stale_command. Agent chỉ log rồi bỏ; job sẽ được claim
 * lại ở lần poll kế. Đây là bản chất at-least-once — handler phải
 * idempotent.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ResultBody {
  command_id: string;
  status: "done" | "failed";
  result: Record<string, unknown> | null;
  error_message: string | null;
}

type ParseOutcome = { ok: true; body: ResultBody } | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const commandId = typeof r.command_id === "string" ? r.command_id.trim() : "";
  if (!commandId) return { ok: false, error: "command_id_required" };
  if (!UUID_RE.test(commandId)) return { ok: false, error: "command_id_invalid" };

  const status = typeof r.status === "string" ? r.status.trim() : "";
  if (status !== "done" && status !== "failed") {
    return { ok: false, error: "status_invalid" };
  }

  const result =
    r.result && typeof r.result === "object"
      ? (r.result as Record<string, unknown>)
      : null;

  const errorMsg = typeof r.error === "string" ? r.error.trim() : "";
  if (status === "failed" && !errorMsg) {
    return { ok: false, error: "error_required_when_failed" };
  }

  return {
    ok: true,
    body: {
      command_id: commandId,
      status,
      result,
      error_message: errorMsg || null,
    },
  };
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
  const body = parsed.body;

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, status, secret, hmac_v2_enforced_at")
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
    canonicalPath: AGENT_API_PATHS.commandResult,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  // Atomic close: chỉ update khi status='taken' và agent_id khớp.
  // Agent A không được đóng job của agent B kể cả khi biết command_id.
  // SELECT thêm type + payload để nhánh probe_codec xử side-effect ghi
  // cameras.codec_detected.
  const { data: updated, error: updateErr } = await admin
    .from("agent_commands")
    .update({
      status: body.status,
      completed_at: new Date().toISOString(),
      result: body.result,
      error: body.error_message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", body.command_id)
    .eq("agent_id", agent.id)
    .eq("status", "taken")
    .select("id, type, payload, organization_id")
    .maybeSingle();

  if (updateErr) {
    return NextResponse.json(
      { error: "update_failed", message: updateErr.message },
      { status: 500 },
    );
  }
  if (!updated) {
    // Job đã bị reaper trả về pending, hoặc thuộc agent khác, hoặc
    // không tồn tại. Agent log rồi bỏ — không retry ở tầng này.
    return NextResponse.json({ error: "stale_command" }, { status: 409 });
  }

  // 1.2: nhánh probe_codec ghi kết quả vào cameras.codec_detected.
  // Chỉ ghi khi status=done + result có codec. Nếu failed → ghi
  // codec_probe_error (giữ codec_detected cũ, không xóa vì probe cũ
  // vẫn là fact quan sát được trước đó).
  if (updated.type === "probe_codec") {
    const payload = updated.payload as { camera_id?: string } | null;
    const cameraId = payload?.camera_id;
    if (cameraId) {
      const nowIso = new Date().toISOString();
      if (body.status === "done" && body.result) {
        const codec = typeof body.result.codec === "string"
          ? body.result.codec.trim().toLowerCase().slice(0, 50)
          : null;
        const warning = typeof body.result.warning === "string"
          ? body.result.warning.trim().slice(0, 100)
          : null;
        const { error: camErr } = await admin
          .from("cameras")
          .update({
            codec_detected: codec,
            codec_warning: warning,
            codec_probed_at: nowIso,
            codec_probe_error: null,
            updated_at: nowIso,
          })
          .eq("id", cameraId)
          .eq("organization_id", updated.organization_id);
        if (camErr) {
          console.error(
            `[command-result] probe_codec callback update failed cmd=${body.command_id} camera=${cameraId} code=${camErr.code ?? "?"} message=${camErr.message}`,
          );
        }
      } else if (body.status === "failed") {
        const { error: camErr } = await admin
          .from("cameras")
          .update({
            codec_probed_at: nowIso,
            codec_probe_error: (body.error_message ?? "unknown").slice(0, 200),
            updated_at: nowIso,
          })
          .eq("id", cameraId)
          .eq("organization_id", updated.organization_id);
        if (camErr) {
          console.error(
            `[command-result] probe_codec failure callback update failed cmd=${body.command_id} camera=${cameraId} code=${camErr.code ?? "?"} message=${camErr.message}`,
          );
        }
      }
    }
  }

  // Lát 2 SaaS refactor: nhánh test_camera_connection ghi kết quả
  // vào cameras.last_test_result + last_tested_at. Route web POST
  // /api/cameras/[id]/test-connection giờ enqueue command này thay vì
  // spawn ffmpeg trực tiếp (cloud SaaS không tới được camera LAN).
  if (updated.type === "test_camera_connection") {
    const payload = updated.payload as { camera_id?: string } | null;
    const cameraId = payload?.camera_id;
    if (cameraId) {
      const nowIso = new Date().toISOString();
      const success = body.status === "done";
      const testResult: Record<string, unknown> = {
        success,
        message: success
          ? typeof body.result?.message === "string"
            ? body.result.message
            : "Kết nối camera thành công."
          : humanizeTestFailure(body.error_message),
        tested_via: "agent",
      };
      if (!success && body.error_message) {
        // Giữ chuỗi lỗi kỹ thuật để debug sau này, tách khỏi message hiển thị.
        testResult.raw_error = body.error_message;
      }
      if (typeof body.result?.duration_ms === "number") {
        testResult.duration_ms = body.result.duration_ms;
      }
      if (typeof body.result?.transport_used === "string") {
        testResult.transport_used = body.result.transport_used;
      }
      const { error: camErr } = await admin
        .from("cameras")
        .update({
          last_test_result: testResult,
          last_tested_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", cameraId)
        .eq("organization_id", updated.organization_id);
      if (camErr) {
        console.error(
          `[command-result] test_camera_connection callback update failed cmd=${body.command_id} camera=${cameraId} code=${camErr.code ?? "?"} message=${camErr.message}`,
        );
      }
    }
  }

  return NextResponse.json({ ok: true });
}

/**
 * Dịch chuỗi lỗi kỹ thuật từ agent thành thông báo tiếng Việt dễ hiểu cho
 * user. Agent gửi dạng `test_failed: <reason>` với reason là các code như:
 *   - exit_null / exit_null:...  → ffprobe bị SIGKILL do timeout 10s
 *     (camera không trả về gì) → coi là camera offline / mạng không tới.
 *   - exit_1: <stderr tail>       → ffprobe exit code 1 — thường là RTSP
 *     401 (sai username/password) hoặc 404 (sai path).
 *   - proc_error: ...             → lỗi tiến trình OS (hiếm).
 *   - spawn_error: ...            → không spawn được ffprobe (ffprobe binary
 *     mất hoặc corrupt).
 *
 * Nếu không map được, trả về câu hướng dẫn chung + giữ raw_error trong DB
 * để debug qua log.
 */
function humanizeTestFailure(errMsg: string | null): string {
  if (!errMsg) return "Kết nối thất bại. Kiểm tra camera và mạng nội bộ.";
  const s = errMsg.toLowerCase();
  if (s.includes("exit_null")) {
    return "Camera không phản hồi trong 10 giây. Kiểm tra: camera có bật không, IP có đúng không, mạng LAN tới được không (thử ping IP).";
  }
  if (s.includes("401") || s.includes("unauthorized")) {
    return "Sai username hoặc mật khẩu camera. Vào Chỉnh sửa để đổi lại thông tin đăng nhập.";
  }
  if (s.includes("404") || s.includes("not found")) {
    return "Sai đường dẫn RTSP (RTSP path). Vào Chỉnh sửa và kiểm tra lại field RTSP path.";
  }
  if (s.includes("connection refused")) {
    return "Camera từ chối kết nối (port RTSP đóng). Kiểm tra port 554 trên camera, hoặc port đã đổi trong cấu hình camera.";
  }
  if (s.includes("timeout") || s.includes("timed out")) {
    return "Kết nối quá lâu chưa xong. Camera có thể quá xa/mạng yếu, thử test lại.";
  }
  if (s.includes("spawn_error") || s.includes("enoent")) {
    return "Agent gặp lỗi nội bộ (ffprobe). Báo Betacom để kiểm tra máy kho.";
  }
  return "Không kết nối được camera. Kiểm tra camera có bật, đúng IP/port/RTSP path, và cùng mạng LAN với máy kho.";
}
