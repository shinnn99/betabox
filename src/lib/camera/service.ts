import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptPassword, encryptPassword } from "./crypto";
import { buildRtspUrl } from "./rtsp";

// -- Org-scoped in-process cache for listCameras-side joins ----------------
//
// Two caches keyed by organization_id:
//   * softLinksDoneAt: when ensureCameraSoftLinks last ran successfully.
//     Lets us skip the N+2 query pattern (existing rows + used codes)
//     within a short window. Skipping is safe because the only thing
//     it could miss is a brand-new camera created since the last sweep
//     — and the mutation paths invalidate the cache explicitly.
//   * stationMapAt: cached (camera_id -> current_station) lookup.
//
// Why a TTL is acceptable here even with invalidation:
//   The cache is only read by listCameras(), which feeds the
//   /dashboard/devices UI. Scan ingest and clip generation use
//   resolve_scanner_at() / resolve_station_camera_at() RPCs against
//   the live tables; they NEVER touch this cache. So a stale entry
//   here is at most a stale UI line — never a clip attached to the
//   wrong station. The TTL is a defense-in-depth knob in case an
//   invalidation call is forgotten in a future mutation route.
//
// Note on out-of-band mutations:
//   Any path that mutates cameras / station_devices /
//   station_device_assignments WITHOUT going through the API routes
//   listed (cron jobs, ad-hoc SQL, future RPC) will leave the UI
//   stale for up to TTL seconds. Acceptable for an admin UI; document
//   this contract whenever a new write path is added.
//
// Process-only (no Redis) because the app is single-Node on-prem.
// Stashed on globalThis so Next.js dev HMR reloads don't reset the
// map and flap the warning state — same trick as recording.ts.
const SOFT_LINK_TTL_MS = 30_000;
const STATION_MAP_TTL_MS = 30_000;

interface CacheBucket {
  softLinksDoneAt: Map<string, number>;
  stationMap: Map<string, { value: Map<string, CameraPublic["current_station"]>; expiresAt: number }>;
}

const CACHE_GLOBAL_KEY = "__beta_cam_camera_service_cache__";

function getCache(): CacheBucket {
  const g = globalThis as unknown as Record<string, CacheBucket | undefined>;
  if (!g[CACHE_GLOBAL_KEY]) {
    g[CACHE_GLOBAL_KEY] = {
      softLinksDoneAt: new Map(),
      stationMap: new Map(),
    };
  }
  return g[CACHE_GLOBAL_KEY]!;
}

// PUBLIC: mutation routes MUST call this after any change to cameras,
// station_devices, or station_device_assignments that could affect the
// current camera↔station mapping shown to operators.
export function invalidateCameraCaches(organizationId: string): void {
  if (!organizationId) return;
  const c = getCache();
  c.softLinksDoneAt.delete(organizationId);
  c.stationMap.delete(organizationId);
}

// Public-safe shape — never contains password material. Anything that
// leaves the server towards a browser MUST go through `toPublicCamera`.
export interface CameraPublic {
  id: string;
  name: string;
  camera_code: string;
  ip: string;
  rtsp_port: number;
  username: string;
  rtsp_path: string;
  location: string | null;
  status: "active" | "inactive" | "error";
  last_tested_at: string | null;
  last_test_result: Record<string, unknown> | null;
  has_password: boolean;
  created_at: string;
  updated_at: string;
  // The station currently using this camera (via station_devices +
  // station_device_assignments). null when the camera isn't wired up to
  // any station yet — clip generation will report no_camera for scans
  // at stations the operator hasn't mapped. `warehouse_id` lets the
  // warehouse-scoped overview filter cameras down to its own stations.
  current_station: {
    station_id: string;
    station_code: string;
    station_name: string;
    warehouse_id: string;
    is_primary: boolean;
  } | null;
  // 1.2: codec onboard-probe. Null nếu chưa probe.
  codec_detected: string | null;
  codec_warning: string | null;
  codec_probed_at: string | null;
  codec_probe_error: string | null;
  // Lát 2: agent local TCP-connect RTSP port mỗi 30s. UI dùng cùng
  // agent.last_seen_at để phân biệt "Camera offline" (probe fail + agent
  // sống) vs "Mất kết nối kho" (agent chết).
  last_probe_at: string | null;
  last_probe_ok: boolean | null;
  last_probe_latency_ms: number | null;
}

// DB row including encrypted password columns. Internal use only.
export interface CameraRow extends Omit<CameraPublic, "has_password"> {
  password_ciphertext: string | null;
  password_iv: string | null;
  password_tag: string | null;
}

const SAFE_COLUMNS =
  "id, name, camera_code, ip, rtsp_port, username, rtsp_path, location, status, last_tested_at, last_test_result, created_at, updated_at, codec_detected, codec_warning, codec_probed_at, codec_probe_error, last_probe_at, last_probe_ok, last_probe_latency_ms";

const ALL_COLUMNS = `${SAFE_COLUMNS}, password_ciphertext, password_iv, password_tag`;

export function toPublicCamera(row: CameraRow): CameraPublic {
  return {
    id: row.id,
    name: row.name,
    camera_code: row.camera_code,
    ip: row.ip,
    rtsp_port: row.rtsp_port,
    username: row.username,
    rtsp_path: row.rtsp_path,
    location: row.location,
    status: row.status,
    last_tested_at: row.last_tested_at,
    last_test_result: row.last_test_result,
    has_password: Boolean(row.password_ciphertext),
    created_at: row.created_at,
    updated_at: row.updated_at,
    current_station: null,
    codec_detected: row.codec_detected,
    codec_warning: row.codec_warning,
    codec_probed_at: row.codec_probed_at,
    codec_probe_error: row.codec_probe_error,
    last_probe_at: row.last_probe_at,
    last_probe_ok: row.last_probe_ok,
    last_probe_latency_ms: row.last_probe_latency_ms,
  };
}

// Resolve which station each camera currently belongs to. We pull
// station_devices of type=camera (non-archived) and join through to
// packing_stations. camera_id lives inside config_json so we filter in
// JS — postgrest can't safely query inside jsonb across versions.
//
// Result is cached per-org for STATION_MAP_TTL_MS. See the cache
// declaration block at top of file for the safety reasoning. Mutation
// routes invalidate via invalidateCameraCaches(organizationId).
async function loadCameraStationMap(
  organizationId: string,
): Promise<Map<string, CameraPublic["current_station"]>> {
  // Guard: never cache against a falsy org key. Misrouted requests
  // shouldn't leak state into a "" / "undefined" bucket.
  if (!organizationId) return new Map();

  const cache = getCache();
  const cached = cache.stationMap.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("station_devices")
    .select(
      `id, config_json,
       station_device_assignments!inner ( station_id, unassigned_at,
         packing_stations ( id, code, name, warehouse_id )
       )`,
    )
    .eq("organization_id", organizationId)
    .eq("device_type", "camera")
    .neq("status", "archived");

  // DB error path: do NOT cache. An empty result from an error would
  // otherwise pin "no stations mapped" for TTL_MS. Surface to caller —
  // listCameras() catches and returns the empty map (cameras still
  // render, just without current_station). Log so ops can diagnose.
  if (error) {
    console.error(
      `[camera] loadCameraStationMap query failed for org=${organizationId}: ${error.message}`,
    );
    return new Map();
  }

  const map = new Map<string, CameraPublic["current_station"]>();
  for (const sd of (data ?? []) as Array<{
    id: string;
    config_json: Record<string, unknown> | null;
    station_device_assignments: Array<{
      station_id: string;
      unassigned_at: string | null;
      packing_stations:
        | { id: string; code: string; name: string; warehouse_id: string }
        | { id: string; code: string; name: string; warehouse_id: string }[]
        | null;
    }>;
  }>) {
    const cameraId = String(sd.config_json?.camera_id ?? "");
    if (!cameraId) continue;
    const role = String(sd.config_json?.role ?? "");
    const active = (sd.station_device_assignments ?? []).find(
      (a) => a.unassigned_at == null,
    );
    if (!active) continue;
    const stn = Array.isArray(active.packing_stations)
      ? active.packing_stations[0]
      : active.packing_stations;
    if (!stn) continue;
    map.set(cameraId, {
      station_id: stn.id,
      station_code: stn.code,
      station_name: stn.name,
      warehouse_id: stn.warehouse_id,
      is_primary: role === "proof_primary",
    });
  }
  cache.stationMap.set(organizationId, {
    value: map,
    expiresAt: Date.now() + STATION_MAP_TTL_MS,
  });
  return map;
}

export async function listCameras(organizationId: string): Promise<CameraPublic[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cameras")
    .select(ALL_COLUMNS)
    .eq("organization_id", organizationId)
    .order("camera_code", { ascending: true });
  if (error) throw error;
  const cameras = (data ?? []).map((r) => toPublicCamera(r as CameraRow));
  // Self-heal soft-links: every camera should have a station_devices row
  // so the merged /dashboard/devices listing and the assignment endpoint
  // both find it without the caller having to think about two tables.
  await ensureCameraSoftLinks(
    organizationId,
    cameras.map((c) => ({ id: c.id, camera_code: c.camera_code, name: c.name })),
  );
  const stationMap = await loadCameraStationMap(organizationId);
  for (const c of cameras) c.current_station = stationMap.get(c.id) ?? null;
  return cameras;
}

// Idempotently make sure each camera has a backing station_devices row.
// Two requests landing concurrently both attempt insert; the second one
// hits the unique index and we read the existing row instead. We do NOT
// touch the row if it already exists — operators may have customised
// device_code or role/primary on the existing one.
//
// Cached: if a successful sweep ran within SOFT_LINK_TTL_MS for this org,
// skip the SELECT pass entirely. Mutation routes that change cameras
// or station_devices invalidate this via invalidateCameraCaches.
export async function ensureCameraSoftLinks(
  organizationId: string,
  cameras: Array<{ id: string; camera_code: string; name: string }>,
): Promise<void> {
  if (!organizationId) return;
  if (cameras.length === 0) return;
  const cache = getCache();
  const lastOk = cache.softLinksDoneAt.get(organizationId);
  if (lastOk !== undefined && Date.now() - lastOk < SOFT_LINK_TTL_MS) {
    return;
  }
  const admin = createAdminClient();
  // Pull every camera-type station_device once, decide who's missing.
  const { data: existing, error: existingErr } = await admin
    .from("station_devices")
    .select("id, config_json")
    .eq("organization_id", organizationId)
    .eq("device_type", "camera")
    .neq("status", "archived");
  if (existingErr) {
    // Don't pollute cache on read failure — next call will retry.
    console.error(
      `[camera] ensureCameraSoftLinks read failed for org=${organizationId}: ${existingErr.message}`,
    );
    return;
  }
  const claimed = new Set<string>();
  for (const r of (existing ?? []) as Array<{
    id: string;
    config_json: Record<string, unknown> | null;
  }>) {
    const cid = String(r.config_json?.camera_id ?? "");
    if (cid) claimed.add(cid);
  }
  const missing = cameras.filter((c) => !claimed.has(c.id));
  if (missing.length === 0) {
    cache.softLinksDoneAt.set(organizationId, Date.now());
    return;
  }

  // Existing device_codes (any type) to dodge unique collisions on insert.
  const { data: codeRows } = await admin
    .from("station_devices")
    .select("device_code")
    .eq("organization_id", organizationId);
  const usedCodes = new Set<string>(
    ((codeRows ?? []) as Array<{ device_code: string }>).map(
      (r) => r.device_code,
    ),
  );

  for (const cam of missing) {
    let code = `auto_${cam.camera_code}`;
    if (usedCodes.has(code)) {
      // Collision (rare — camera_code is unique per org, but a manual
      // device with the same `auto_*` name may exist). Append a short id.
      code = `${code}_${Math.random().toString(36).slice(2, 6)}`;
    }
    usedCodes.add(code);
    // Status='active' is required because station_device_assignments
    // POST rejects inactive devices; the assignment row decides the
    // station, the device row just owns the camera↔code soft-link.
    const { error: insErr } = await admin.from("station_devices").insert({
      organization_id: organizationId,
      device_code: code,
      device_type: "camera",
      name: cam.name || cam.camera_code,
      status: "active",
      config_json: { camera_id: cam.id },
    });
    if (insErr) {
      // 23505 = unique violation: a concurrent insert won the race; the
      // other request has already created the row. That's the outcome we
      // wanted, so swallow it. Anything else is unexpected — log & move
      // on to the next camera rather than tank the whole list.
      const code23505 = (insErr as { code?: string }).code === "23505";
      if (!code23505) {
        console.warn(
          `[camera] ensureCameraSoftLinks failed for camera=${cam.id}: ${insErr.message}`,
        );
      }
    }
  }
  // Mark sweep as complete so subsequent listCameras within TTL skip
  // the SELECT pass. We mark even on per-row errors above: the goal of
  // the cache is to amortize the discovery cost, not to gate retries
  // (those happen on the next mutation-triggered invalidation).
  cache.softLinksDoneAt.set(organizationId, Date.now());
}

export async function getCameraRow(
  organizationId: string,
  id: string,
): Promise<CameraRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cameras")
    .select(ALL_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as CameraRow | null) ?? null;
}

// Build a usable RTSP URL by decrypting the stored password. Throws if the
// camera has no password configured — callers should surface a 400.
export function buildRtspForRow(row: CameraRow): string {
  let password: string | null = null;
  if (row.password_ciphertext && row.password_iv && row.password_tag) {
    password = decryptPassword({
      ciphertext: row.password_ciphertext,
      iv: row.password_iv,
      tag: row.password_tag,
    });
  }
  return buildRtspUrl({
    ip: row.ip,
    port: row.rtsp_port,
    username: row.username,
    password,
    path: row.rtsp_path,
  });
}

export interface CameraInput {
  name: string;
  camera_code: string;
  ip: string;
  rtsp_port?: number;
  username?: string;
  password?: string | null; // plaintext from client; encrypted before write
  rtsp_path?: string;
  location?: string | null;
}

// IPv4 dotted-quad or any hostname-like token. Loose on purpose — accept
// IPv6, internal DNS names, etc. We just reject empty / whitespace-only.
function validateIp(v: string): boolean {
  return typeof v === "string" && v.trim().length > 0 && !/\s/.test(v);
}
function validatePort(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && v <= 65535;
}
function validatePath(v: string): boolean {
  return typeof v === "string" && v.length > 0 && !/\s/.test(v);
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateCameraInput(
  input: CameraInput,
  mode: "create" | "update",
): ValidationError | null {
  if (mode === "create" || input.name !== undefined) {
    if (!input.name || !input.name.trim()) {
      return { field: "name", message: "Tên camera là bắt buộc." };
    }
  }
  if (mode === "create" || input.camera_code !== undefined) {
    if (!input.camera_code || !input.camera_code.trim()) {
      return { field: "camera_code", message: "Mã camera là bắt buộc." };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(input.camera_code)) {
      return {
        field: "camera_code",
        message: "Mã camera chỉ chứa chữ, số, gạch dưới, gạch nối.",
      };
    }
  }
  if (mode === "create" || input.ip !== undefined) {
    if (!validateIp(input.ip ?? "")) {
      return { field: "ip", message: "IP không hợp lệ." };
    }
  }
  if (input.rtsp_port !== undefined && !validatePort(input.rtsp_port)) {
    return { field: "rtsp_port", message: "Port phải nằm trong 1..65535." };
  }
  if (input.rtsp_path !== undefined && !validatePath(input.rtsp_path)) {
    return { field: "rtsp_path", message: "RTSP path không hợp lệ." };
  }
  return null;
}

export async function createCamera(
  organizationId: string,
  input: CameraInput,
): Promise<CameraPublic> {
  const admin = createAdminClient();
  const enc = input.password ? encryptPassword(input.password) : null;
  const { data, error } = await admin
    .from("cameras")
    .insert({
      organization_id: organizationId,
      name: input.name.trim(),
      camera_code: input.camera_code.trim(),
      ip: input.ip.trim(),
      rtsp_port: input.rtsp_port ?? 554,
      username: (input.username ?? "admin").trim() || "admin",
      rtsp_path: input.rtsp_path?.trim() || "/ch1/main",
      location: input.location?.trim() || null,
      password_ciphertext: enc?.ciphertext ?? null,
      password_iv: enc?.iv ?? null,
      password_tag: enc?.tag ?? null,
    })
    .select(ALL_COLUMNS)
    .single();
  if (error) throw error;
  invalidateCameraCaches(organizationId);
  return toPublicCamera(data as CameraRow);
}

// Only the fields the caller actually provided are written. password
// follows three states:
//   - undefined: keep existing password
//   - "": clear password (set all three columns NULL)
//   - non-empty string: encrypt and replace
export async function updateCamera(
  organizationId: string,
  id: string,
  input: Partial<CameraInput> & {
    status?: "active" | "inactive" | "error";
  },
): Promise<CameraPublic | null> {
  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name.trim();
  if (input.camera_code !== undefined)
    update.camera_code = input.camera_code.trim();
  if (input.ip !== undefined) update.ip = input.ip.trim();
  if (input.rtsp_port !== undefined) update.rtsp_port = input.rtsp_port;
  if (input.username !== undefined) update.username = input.username.trim();
  if (input.rtsp_path !== undefined) update.rtsp_path = input.rtsp_path.trim();
  if (input.location !== undefined)
    update.location = input.location?.trim() || null;
  if (input.status !== undefined) update.status = input.status;

  if (input.password !== undefined) {
    if (input.password === null || input.password === "") {
      update.password_ciphertext = null;
      update.password_iv = null;
      update.password_tag = null;
    } else {
      const enc = encryptPassword(input.password);
      update.password_ciphertext = enc.ciphertext;
      update.password_iv = enc.iv;
      update.password_tag = enc.tag;
    }
  }

  if (Object.keys(update).length === 0) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cameras")
    .update(update)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .select(ALL_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (data) invalidateCameraCaches(organizationId);
  return data ? toPublicCamera(data as CameraRow) : null;
}

export class HasProofClipsError extends Error {
  code = "has_proof_clips" as const;
  clipsCount: number;
  constructor(clipsCount: number) {
    super(`Camera còn ${clipsCount} clip pháp lý gắn với đơn hàng.`);
    this.clipsCount = clipsCount;
  }
}

export async function deleteCamera(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const admin = createAdminClient();

  // Chặn trước khi FK RESTRICT vỡ: clip pháp lý gắn với đơn hàng cụ thể,
  // không cascade theo camera. Caller phải soft-delete (chuyển inactive).
  const { count: clipsCount } = await admin
    .from("order_proof_clips")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("camera_id", id);

  if ((clipsCount ?? 0) > 0) {
    throw new HasProofClipsError(clipsCount ?? 0);
  }

  const { error, count } = await admin
    .from("cameras")
    .delete({ count: "exact" })
    .eq("organization_id", organizationId)
    .eq("id", id);
  if (error) throw error;
  const deleted = (count ?? 0) > 0;
  if (deleted) invalidateCameraCaches(organizationId);
  return deleted;
}

export async function recordTestResult(
  organizationId: string,
  id: string,
  result: { success: boolean; message: string; meta?: Record<string, unknown> },
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("cameras")
    .update({
      last_tested_at: new Date().toISOString(),
      last_test_result: {
        success: result.success,
        message: result.message,
        ...(result.meta ?? {}),
      },
      // Promote camera to active on first successful test; mark error on failure.
      status: result.success ? "active" : "error",
    })
    .eq("organization_id", organizationId)
    .eq("id", id);
}
