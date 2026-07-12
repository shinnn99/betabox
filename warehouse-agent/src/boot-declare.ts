import { signBodyV2 } from "./signing";
import { AGENT_API_PATHS } from "./agent-api-paths";
import { fetchWithRetrySigned } from "./fetch-error";

/**
 * Gọi POST /api/agent/boot-declare — báo cloud danh sách camera_id CÓ ffmpeg
 * đang chạy thật sau boot recovery (registry kill + marker sweep + verify sạch).
 *
 * Cloud đóng mọi session `recording`/`connection_lost` của org agent thuộc
 * camera KHÔNG trong `aliveCameraIds`, error_message='agent_boot_declared_clean'.
 *
 * CỨNG: gọi CHỈ khi verify quét-lại-sau-kill trả 0 ffmpeg marker còn sống.
 * KHÔNG được gửi `aliveCameraIds=[]` mù — tin "tôi đã kill" ≠ "process đã chết".
 */
export interface BootDeclareResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function callBootDeclare(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  aliveCameraIds: string[];
}): Promise<BootDeclareResult> {
  const body = JSON.stringify({ alive_camera_ids: params.aliveCameraIds });
  const res = await fetchWithRetrySigned(
    `${params.backendUrl}${AGENT_API_PATHS.bootDeclare}`,
    () => ({
      method: "POST",
      headers: signBodyV2({
        agentCode: params.agentCode,
        agentSecret: params.agentSecret,
        method: "POST",
        canonicalPath: AGENT_API_PATHS.bootDeclare,
        body,
      }),
      body,
      redirect: "manual",
    }),
  );

  if (res.status >= 300 && res.status < 400) {
    return {
      ok: false,
      status: res.status,
      body: {
        error: "intercepted_redirect",
        location: res.headers.get("location"),
      },
    };
  }

  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  return { ok: res.ok, status: res.status, body: parsed };
}
