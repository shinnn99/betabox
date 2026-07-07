import net from "node:net";
import { URL } from "node:url";
import { signBodyV2 } from "./signing";
import { AGENT_API_PATHS } from "./agent-api-paths";
import { describeFetchError, fetchWithRetrySigned } from "./fetch-error";

/**
 * Lát 2: mỗi 30s TCP-connect RTSP port của mọi camera đang có ffmpeg
 * chạy trên agent này, batch report lên cloud. UI đọc để phân biệt
 * "Camera offline" vs "Mất kết nối kho".
 *
 * Chọn TCP connect (không ffprobe):
 *   - Nhẹ (~200ms), phù hợp loop 30s. ffprobe 2-5s không hợp.
 *   - Không đụng credential — chỉ connect port, không auth.
 *   - Đủ chứng minh "IP camera nghe RTSP port" cho chẩn vật-lý-on/off.
 *
 * Timeout 2s: connect refused sẽ về ngay (~5ms), timeout mới hết 2s.
 * Cả hai đều gộp thành ok=false — Lát sau tách nếu cần chẩn sâu (refused
 * = camera off; timeout = mạng chậm/camera treo).
 *
 * BẮT BUỘC report cả ok=true và ok=false. Chỉ report ok=true sẽ khiến
 * camera vừa tắt phải chờ 90s stale mới đổi "Offline" — chậm 90s. Report
 * cả fail thì Offline hiện trong nhịp probe kế (30s).
 */
const CONNECT_TIMEOUT_MS = 2000;

export interface ProbeTarget {
  cameraId: string;
  cameraCode: string;
  rtspUrl: string;
}

export interface ProbeResult {
  camera_id: string;
  ok: boolean;
  latency_ms: number | null;
}

export function extractHostPort(
  rtspUrl: string,
): { host: string; port: number } | null {
  try {
    const u = new URL(rtspUrl);
    const host = u.hostname;
    const port = u.port ? Number(u.port) : 554;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return null;
    }
    return { host, port };
  } catch {
    return null;
  }
}

export function tcpConnect(
  host: string,
  port: number,
): Promise<{ ok: boolean; latencyMs: number | null }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      const latencyMs = Date.now() - t0;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok, latencyMs: ok ? latencyMs : null });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, host);
  });
}

export async function probeTargets(
  targets: ProbeTarget[],
): Promise<ProbeResult[]> {
  const results = await Promise.all(
    targets.map(async (t) => {
      const hp = extractHostPort(t.rtspUrl);
      if (!hp) {
        return { camera_id: t.cameraId, ok: false, latency_ms: null };
      }
      const { ok, latencyMs } = await tcpConnect(hp.host, hp.port);
      return { camera_id: t.cameraId, ok, latency_ms: latencyMs };
    }),
  );
  return results;
}

export async function reportProbes(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  probes: ProbeResult[];
}): Promise<void> {
  if (params.probes.length === 0) return;
  const body = JSON.stringify({ probes: params.probes });
  try {
    const res = await fetchWithRetrySigned(
      `${params.backendUrl}${AGENT_API_PATHS.cameraProbe}`,
      () => ({
        method: "POST",
        headers: signBodyV2({
          agentCode: params.agentCode,
          agentSecret: params.agentSecret,
          method: "POST",
          canonicalPath: AGENT_API_PATHS.cameraProbe,
          body,
        }),
        body,
        redirect: "manual",
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[camera-probe] report failed ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`[camera-probe] report threw: ${describeFetchError(err)}`);
  }
}
