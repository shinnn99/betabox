import { signBody } from "./signing";
import { fetchWithRetry } from "./fetch-error";

/**
 * Heartbeat có RETRY. Nếu tất cả retry đều fail, throw để caller quyết
 * (VD skip nhịp này, log lần đầu qua rate limiter). Không nuốt lỗi ngầm
 * — heartbeat fail nhiều = agent thực sự offline, cần biết.
 */
export async function sendHeartbeat(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
}): Promise<{ ok: boolean; status: number }> {
  const body = JSON.stringify({ ping: true });
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  const res = await fetchWithRetry(
    `${params.backendUrl}/api/warehouse/heartbeat`,
    {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    },
    { label: "heartbeat" },
  );
  return { ok: res.ok, status: res.status };
}
