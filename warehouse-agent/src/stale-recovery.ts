import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "./fetch-error";
import { signBody } from "./signing";

/**
 * HIGH-13 (B4): DB-verified `.stale` recovery + quarantine.
 *
 * Trước khi rename tmp → canonical trong boot recovery, gọi backend
 * endpoint verify marker (clip_id, packing_event_id, bucket_path) khớp
 * DB order_proof_clips. Backend trả:
 *   - verdict='recover' → agent tiến hành rename như cũ.
 *   - verdict='quarantine' + reason → agent MOVE .stale + .tmp sang
 *     _quarantine/stale-recovery/<timestamp>_<clip_id>_<reason> + ghi
 *     sidecar JSON.
 *   - HTTP error / mạng chết → giữ nguyên .stale + .tmp, KHÔNG xóa
 *     canonical. Log để ops kiểm.
 *
 * Bảo vệ evidence integrity: marker corrupt / pe_id trong marker sai
 * KHÔNG dẫn đến xóa canonical đúng của PE khác.
 */

export interface StaleMarker {
  clip_id: string;
  packing_event_id: string;
  command_id?: string;
  bucket_path: string;
  created_at?: string;
  reason?: string;
}

export type StaleVerdict =
  | { kind: "recover"; clip_id: string; packing_event_id: string }
  | { kind: "quarantine"; reason: string; extra?: Record<string, unknown> }
  | { kind: "unavailable"; reason: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate marker shape TRƯỚC khi gọi backend. Marker corrupt = quarantine
 * ngay, không tốn round-trip.
 */
export function validateMarker(m: unknown): {
  ok: boolean;
  reason?: string;
} {
  if (!m || typeof m !== "object") return { ok: false, reason: "not_object" };
  const r = m as Record<string, unknown>;
  if (typeof r.clip_id !== "string" || !UUID_RE.test(r.clip_id)) {
    return { ok: false, reason: "clip_id_invalid" };
  }
  if (
    typeof r.packing_event_id !== "string" ||
    !UUID_RE.test(r.packing_event_id)
  ) {
    return { ok: false, reason: "packing_event_id_invalid" };
  }
  if (
    typeof r.bucket_path !== "string" ||
    r.bucket_path.length < 5 ||
    r.bucket_path.length > 500
  ) {
    return { ok: false, reason: "bucket_path_invalid" };
  }
  return { ok: true };
}

export interface VerifyStaleMarkerArgs {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  marker: StaleMarker;
}

/**
 * Gọi backend verify endpoint. Trả verdict trong cấu trúc typed.
 * KHÔNG throw — mọi lỗi mạng/DB được map sang { kind: 'unavailable' }.
 */
export async function verifyStaleMarker(
  args: VerifyStaleMarkerArgs,
): Promise<StaleVerdict> {
  const body = JSON.stringify({
    clip_id: args.marker.clip_id,
    packing_event_id: args.marker.packing_event_id,
    bucket_path: args.marker.bucket_path,
  });

  const routePath = "/api/agent/verify-clip-stale-marker";
  const url = `${args.backendUrl.replace(/\/$/, "")}${routePath}`;

  // Signature v1 (backward-compat với B1.3). Agent v0.4 sẽ upgrade v2.
  const headers = signBody({
    agentCode: args.agentCode,
    agentSecret: args.agentSecret,
    body,
  });

  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        body,
      },
      { maxAttempts: 3, initialDelayMs: 500, label: "verify-stale" },
    );
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `network: ${(err as Error).message}`,
    };
  }

  if (!response.ok) {
    return {
      kind: "unavailable",
      reason: `http_${response.status}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "unavailable", reason: "invalid_json_response" };
  }

  const r = parsed as Record<string, unknown>;
  if (r.verdict === "recover") {
    return {
      kind: "recover",
      clip_id: String(r.clip_id ?? ""),
      packing_event_id: String(r.packing_event_id ?? ""),
    };
  }
  if (r.verdict === "quarantine") {
    const extra: Record<string, unknown> = {};
    for (const k of ["expected", "status"]) {
      if (k in r) extra[k] = r[k];
    }
    return {
      kind: "quarantine",
      reason: String(r.reason ?? "unknown"),
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  }
  return { kind: "unavailable", reason: "unknown_verdict" };
}

/**
 * Path helper: `_quarantine/stale-recovery/<timestamp>_<clip_id>_<reason>/`.
 * Path deterministic để ops tìm được.
 *
 * Format timestamp: ISO không có ký tự đặc biệt filesystem (YYYYMMDDTHHmmssZ).
 */
export function buildQuarantineDir(
  clipsDir: string,
  clipId: string,
  reason: string,
  now: Date = new Date(),
): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  // Sanitize reason: chỉ giữ [a-z0-9_].
  const safeReason = reason.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return path.join(
    clipsDir,
    "_quarantine",
    "stale-recovery",
    `${ts}_${clipId}_${safeReason}`,
  );
}

/**
 * Sidecar metadata format. Không ghi credential, không ghi signed URL.
 */
export interface QuarantineSidecar {
  quarantined_at: string;
  reason: string;
  extra?: Record<string, unknown>;
  marker: StaleMarker;
  original: {
    stale_path: string;
    tmp_path: string;
    tmp_exists: boolean;
  };
}

export interface QuarantineArgs {
  clipsDir: string;
  staleAbs: string;
  tmpAbs: string;
  marker: StaleMarker;
  reason: string;
  extra?: Record<string, unknown>;
  now?: Date;
}

/**
 * MOVE .stale + .tmp sang quarantine dir + ghi sidecar JSON.
 * Rename intra-volume atomic (cùng filesystem). KHÔNG xóa/đụng canonical.
 */
export async function quarantineStaleGeneration(
  args: QuarantineArgs,
): Promise<{ ok: boolean; dir?: string; error?: string }> {
  const dir = buildQuarantineDir(
    args.clipsDir,
    args.marker.clip_id,
    args.reason,
    args.now ?? new Date(),
  );
  try {
    await fsp.mkdir(dir, { recursive: true });
    // Sidecar TRƯỚC — để có bằng chứng ngay cả khi rename tmp fail.
    const sidecar: QuarantineSidecar = {
      quarantined_at: (args.now ?? new Date()).toISOString(),
      reason: args.reason,
      extra: args.extra,
      marker: args.marker,
      original: {
        stale_path: args.staleAbs,
        tmp_path: args.tmpAbs,
        tmp_exists: existsSync(args.tmpAbs),
      },
    };
    await fsp.writeFile(
      path.join(dir, "sidecar.json"),
      JSON.stringify(sidecar, null, 2),
      "utf8",
    );

    // Rename .stale marker.
    const staleBase = path.basename(args.staleAbs);
    if (existsSync(args.staleAbs)) {
      await fsp.rename(args.staleAbs, path.join(dir, staleBase));
    }
    // Rename .tmp.
    const tmpBase = path.basename(args.tmpAbs);
    if (existsSync(args.tmpAbs)) {
      await fsp.rename(args.tmpAbs, path.join(dir, tmpBase));
    }
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
