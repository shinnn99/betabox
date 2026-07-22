import { signBodyV2 } from "./signing";
import { AGENT_API_PATHS } from "./agent-api-paths";
import { fetchWithRetrySigned } from "./fetch-error";

/**
 * Heartbeat có RETRY. Nếu tất cả retry đều fail, throw để caller quyết
 * (VD skip nhịp này, log lần đầu qua rate limiter). Không nuốt lỗi ngầm
 * — heartbeat fail nhiều = agent thực sự offline, cần biết.
 *
 * NTP guard: mỗi nhịp heartbeat gọi kèm /api/warehouse/time-check để
 * tính drift, gửi số cùng body. Backend lưu warehouse_agents.time_drift_seconds
 * để dashboard hiện badge cảnh báo. Nếu time-check fail, bỏ qua drift
 * (không blocker heartbeat).
 */
export async function sendHeartbeat(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  /** v0.7.1: ms kể từ watchdog tick cuối chạy xong. Nếu > 2× check
   *  interval (60s), watchdog có thể treo âm thầm (ổ I/O hang qua
   *  AbortSignal fail). Cloud endpoint HIỆN CHƯA đọc field này —
   *  agent gửi kèm để log + dự phòng cloud dashboard alert sau. */
  watchdogLastTickMsAgo?: number;
}): Promise<{
  ok: boolean;
  status: number;
  driftSeconds: number | null;
  retentionDays: number | null;
}> {
  // Đo drift trước heartbeat. Nếu fail, tiếp tục với null.
  const driftSeconds = await measureTimeDrift(params.backendUrl);

  const bodyObj: Record<string, unknown> = { ping: true };
  if (driftSeconds !== null) {
    bodyObj.time_drift_seconds = driftSeconds;
  }
  if (typeof params.watchdogLastTickMsAgo === "number") {
    bodyObj.watchdog_last_tick_ms_ago = params.watchdogLastTickMsAgo;
    // Log khi vượt ngưỡng — dự phòng cho ca AbortSignal fail hoặc bug
    // khác treo watchdog. Ngưỡng 90s = 3× checkIntervalMs.
    if (params.watchdogLastTickMsAgo > 90_000) {
      console.warn(
        `[heartbeat] watchdog liveness stale: ${params.watchdogLastTickMsAgo}ms — watchdog có thể treo`,
      );
    }
  }
  const body = JSON.stringify(bodyObj);
  const res = await fetchWithRetrySigned(
    `${params.backendUrl}${AGENT_API_PATHS.heartbeat}`,
    () => ({
      method: "POST",
      headers: signBodyV2({
        agentCode: params.agentCode,
        agentSecret: params.agentSecret,
        method: "POST",
        canonicalPath: AGENT_API_PATHS.heartbeat,
        body,
      }),
      body,
      redirect: "manual",
    }),
    { label: "heartbeat" },
  );
  // Parse retention_days từ response. Cloud trả NULL khi org chưa cấu
  // hình → agent KHÔNG cache (script cleanup fail-loud). Chỉ cache khi
  // cloud trả số hợp lệ.
  let retentionDays: number | null = null;
  if (res.ok) {
    try {
      const json = (await res.json()) as { retention_days?: unknown };
      if (
        typeof json.retention_days === "number" &&
        Number.isInteger(json.retention_days) &&
        json.retention_days >= 7 &&
        json.retention_days <= 365
      ) {
        retentionDays = json.retention_days;
      }
    } catch {
      // Body không parse được — bỏ qua, giữ null. Không phá heartbeat.
    }
  }

  return { ok: res.ok, status: res.status, driftSeconds, retentionDays };
}

/**
 * Đo drift = |agent_now - server_now|. Compensate half-RTT (network
 * latency) để không nhầm latency với drift thật.
 *
 * Cách đo:
 *   t0 = agent_now trước request
 *   server_now = từ response
 *   t1 = agent_now sau response
 *   rtt = t1 - t0
 *   agent_estimated_at_server_time = t0 + rtt/2
 *   drift = |server_now - agent_estimated_at_server_time|
 *
 * Ngưỡng chấp nhận: đo 3 lần, lấy MIN (loại đo bị latency spike).
 * Trả về null nếu tất cả 3 lần fail (mạng chết).
 */
async function measureTimeDrift(backendUrl: string): Promise<number | null> {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const sample = await measureOnce(backendUrl);
    if (sample !== null) samples.push(sample);
  }
  if (samples.length === 0) return null;
  // Lấy MIN — sample có latency spike sẽ có drift-ảo cao, MIN là ước
  // lượng gần thật nhất.
  return Math.min(...samples);
}

async function measureOnce(backendUrl: string): Promise<number | null> {
  const t0 = Date.now();
  try {
    // Time-check endpoint không HMAC (chỉ trả giờ, không lộ gì), request
    // đơn giản. Timeout ngắn (3s) — nếu chậm hơn thì RTT compensation
    // không đáng tin.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${backendUrl}/api/warehouse/time-check`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as { server_time_ms?: unknown };
    if (typeof json.server_time_ms !== "number") return null;
    const t1 = Date.now();
    const rtt = t1 - t0;
    const agentEstimatedAtServer = t0 + rtt / 2;
    const driftMs = Math.abs(json.server_time_ms - agentEstimatedAtServer);
    return Math.round(driftMs / 1000);
  } catch {
    return null;
  }
}
