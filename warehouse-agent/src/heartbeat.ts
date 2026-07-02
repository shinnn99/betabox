import { signBody } from "./signing";

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
  const res = await fetch(`${params.backendUrl}/api/warehouse/heartbeat`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
  return { ok: res.ok, status: res.status };
}
