import "server-only";

// Light HTTP probes used to enrich discovery results.
//
// We only do *anonymous* probes here — no credentials are sent or asked
// for. The point is to upgrade a "Cần kiểm tra" row to "Có thể là
// camera" by reading server/title hints from common camera firmware
// signatures, and to confirm an /onvif/device_service endpoint exists
// (a strong camera signal even when port 554 is closed).
//
// All probes are wrapped with AbortController and a short timeout so a
// hung host can't stall the scan.

export interface ProbeResult {
  // True if /onvif/device_service responded (any 2xx/3xx/4xx — even 401
  // means the endpoint is alive). 5xx and network errors are false.
  onvif_endpoint_alive: boolean;
  // Lower-cased "Server" header, if any. Truncated to 120 chars defensively.
  server_header: string | null;
  // <title> contents from HTTP GET /, if any. Truncated.
  page_title: string | null;
  // Best-effort vendor guess derived from server/title.
  vendor_guess: string | null;
}

const PROBE_TIMEOUT_MS = 1200;
const MAX_BODY_BYTES = 8 * 1024; // we only need <title>, no need to read more

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
      // Browsers ignore most of these but we set them so fetch on the
      // server doesn't follow redirects to public hosts.
      redirect: "manual",
      cache: "no-store",
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Read at most MAX_BODY_BYTES, decoded with the response's Content-Type
// charset when present; fallback to utf-8 / latin1 if decoding fails.
async function readSnippet(res: Response): Promise<string> {
  try {
    const buf = await res.arrayBuffer();
    const trimmed =
      buf.byteLength > MAX_BODY_BYTES
        ? buf.slice(0, MAX_BODY_BYTES)
        : buf;
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

// Very conservative vendor classifier. We only label when we're confident
// — a wrong vendor label is worse than no label, because it locks the UI
// into showing a brand the operator has to ignore. Patterns picked from
// real Hikvision/Dahua/EZVIZ/Reolink/TP-Link firmwares we've seen.
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

export async function probeHttp(
  ip: string,
  ports: number[],
): Promise<ProbeResult> {
  // We probe the first web-ish port we find. Most cameras serve their
  // landing page on whichever of 80/8080/8000 is open.
  const webPort = ports.find((p) => p === 80 || p === 8080 || p === 8000);
  let server_header: string | null = null;
  let page_title: string | null = null;
  let onvif_endpoint_alive = false;

  // ONVIF endpoint probe: a HEAD on /onvif/device_service is cheap and
  // works on most devices. Some respond with 405 to HEAD; we treat any
  // non-network-error as "alive".
  if (webPort) {
    const onvifUrl = `http://${ip}:${webPort}/onvif/device_service`;
    const onvifRes = await fetchWithTimeout(onvifUrl, { method: "HEAD" });
    if (onvifRes && onvifRes.status < 500) {
      onvif_endpoint_alive = true;
      const srv = onvifRes.headers.get("server");
      if (srv) server_header = srv.toLowerCase().slice(0, 120);
    }

    // Landing page for server/title hints.
    const rootRes = await fetchWithTimeout(`http://${ip}:${webPort}/`, {
      method: "GET",
    });
    if (rootRes) {
      if (!server_header) {
        const srv = rootRes.headers.get("server");
        if (srv) server_header = srv.toLowerCase().slice(0, 120);
      }
      // Only bother decoding if the content-type looks textual; binary
      // streams would chew bytes for nothing.
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
