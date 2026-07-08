// MIRROR của beta_cam/src/lib/camera/probe.ts — copy nguyên logic, bỏ
// `import "server-only"`. Đồng bộ khi sửa gốc.

export interface ProbeResult {
  onvif_endpoint_alive: boolean;
  server_header: string | null;
  page_title: string | null;
  vendor_guess: string | null;
}

const PROBE_TIMEOUT_MS = 1200;
const MAX_BODY_BYTES = 8 * 1024;

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { method: "GET" | "HEAD" },
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: "manual",
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readSnippet(res: Response): Promise<string> {
  try {
    const buf = await res.arrayBuffer();
    const trimmed = buf.byteLength > MAX_BODY_BYTES ? buf.slice(0, MAX_BODY_BYTES) : buf;
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(trimmed);
    } catch {
      return new TextDecoder("latin1").decode(trimmed);
    }
  } catch {
    return "";
  }
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title>([^<]{1,200})<\/title>/i);
  if (!m) return null;
  const t = m[1].trim();
  return t.length > 0 ? t.slice(0, 120) : null;
}

function guessVendor(server: string | null, title: string | null): string | null {
  const blob = `${server ?? ""} ${title ?? ""}`.toLowerCase();
  if (!blob.trim()) return null;
  if (blob.includes("hikvision")) return "Hikvision";
  if (blob.includes("dahua") || blob.includes("dnvrs-webs")) return "Dahua";
  if (blob.includes("ezviz")) return "EZVIZ";
  if (blob.includes("reolink")) return "Reolink";
  if (blob.includes("tp-link") || blob.includes("tplink")) return "TP-Link";
  if (blob.includes("uniview") || blob.includes("uniarch")) return "Uniview";
  if (blob.includes("axis")) return "Axis";
  if (blob.includes("vivotek")) return "Vivotek";
  if (blob.includes("imou")) return "Imou";
  return null;
}

export async function probeHttp(ip: string, ports: number[]): Promise<ProbeResult> {
  const webPort = ports.find((p) => p === 80 || p === 8080 || p === 8000);
  let server_header: string | null = null;
  let page_title: string | null = null;
  let onvif_endpoint_alive = false;

  if (webPort) {
    const onvifUrl = `http://${ip}:${webPort}/onvif/device_service`;
    const onvifRes = await fetchWithTimeout(onvifUrl, { method: "HEAD" });
    if (onvifRes && onvifRes.status < 500) {
      onvif_endpoint_alive = true;
      const srv = onvifRes.headers.get("server");
      if (srv) server_header = srv.toLowerCase().slice(0, 120);
    }

    const rootRes = await fetchWithTimeout(`http://${ip}:${webPort}/`, { method: "GET" });
    if (rootRes) {
      if (!server_header) {
        const srv = rootRes.headers.get("server");
        if (srv) server_header = srv.toLowerCase().slice(0, 120);
      }
      const ct = rootRes.headers.get("content-type") ?? "";
      if (/text\/html|xml|json|plain/i.test(ct)) {
        const snippet = await readSnippet(rootRes);
        page_title = extractTitle(snippet);
      }
    }
  }

  return {
    onvif_endpoint_alive,
    server_header,
    page_title,
    vendor_guess: guessVendor(server_header, page_title),
  };
}
