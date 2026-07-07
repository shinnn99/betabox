import { signBodyV2 } from "./signing";
import { AGENT_API_PATHS } from "./agent-api-paths";
import { fetchWithRetrySigned } from "./fetch-error";

export interface AgentCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

interface PollResponse {
  ok: boolean;
  commands?: AgentCommand[];
  error?: string;
}

/**
 * Short-poll cloud lấy danh sách job pending của agent này.
 *
 * At-least-once: nếu agent handle chậm quá visibility timeout, backend
 * reaper sẽ kéo job về 'pending' và lần poll kế có thể claim lại cùng
 * job. Handler phía agent phải idempotent — với PING vô hại, với job
 * thật sau này phải tự khoá theo command_id.
 */
export async function pollCommands(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
}): Promise<AgentCommand[]> {
  const body = JSON.stringify({});
  const res = await fetchWithRetrySigned(
    `${params.backendUrl}${AGENT_API_PATHS.pollCommands}`,
    () => ({
      method: "POST",
      headers: signBodyV2({
        agentCode: params.agentCode,
        agentSecret: params.agentSecret,
        method: "POST",
        canonicalPath: AGENT_API_PATHS.pollCommands,
        body,
      }),
      body,
      redirect: "manual",
    }),
  );
  if (!res.ok) {
    throw new Error(`poll-commands ${res.status}`);
  }
  const json = (await res.json()) as PollResponse;
  return json.commands ?? [];
}

/**
 * Body gửi kèm poll để cloud biết agent đang thật sự ghi camera nào.
 * Cloud dùng để cập nhật camera_recording_sessions.last_heartbeat_at
 * cho các session được nhắc tới.
 */
export interface ActiveRecordingReport {
  session_id: string;
  camera_id: string;
  pid: number;
  started_at: string;
}

/**
 * Bản mở rộng của pollCommands có gửi kèm agent_state. Agent Lát 1 dùng
 * pollCommands() với body {}; Lát 2 dùng biến thể này. Backend nuốt
 * được cả hai — agent_state là optional.
 */
export async function pollCommandsWithState(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  activeRecordings: ActiveRecordingReport[];
  encodingBusy?: boolean;
}): Promise<AgentCommand[]> {
  const body = JSON.stringify({
    agent_state: { active_recordings: params.activeRecordings },
    encoding_busy: params.encodingBusy ?? false,
  });
  const res = await fetchWithRetrySigned(
    `${params.backendUrl}${AGENT_API_PATHS.pollCommands}`,
    () => ({
      method: "POST",
      headers: signBodyV2({
        agentCode: params.agentCode,
        agentSecret: params.agentSecret,
        method: "POST",
        canonicalPath: AGENT_API_PATHS.pollCommands,
        body,
      }),
      body,
      redirect: "manual",
    }),
  );
  if (!res.ok) {
    throw new Error(`poll-commands ${res.status}`);
  }
  const json = (await res.json()) as PollResponse;
  return json.commands ?? [];
}

export interface CredentialItem {
  camera_id: string;
  camera_code: string;
  rtsp_url: string;
  transport: "tcp" | "udp";
  segment_seconds: number;
}

export async function fetchRecordingCredentials(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  cameraIds: string[];
}): Promise<CredentialItem[]> {
  const body = JSON.stringify({ camera_ids: params.cameraIds });
  const res = await fetchWithRetrySigned(
    `${params.backendUrl}${AGENT_API_PATHS.recordingCredentials}`,
    () => ({
      method: "POST",
      headers: signBodyV2({
        agentCode: params.agentCode,
        agentSecret: params.agentSecret,
        method: "POST",
        canonicalPath: AGENT_API_PATHS.recordingCredentials,
        body,
      }),
      body,
      redirect: "manual",
    }),
  );
  if (!res.ok) {
    throw new Error(`recording-credentials ${res.status}`);
  }
  const json = (await res.json()) as { ok: boolean; items?: CredentialItem[] };
  return json.items ?? [];
}

/**
 * Lấy credential (bao gồm RTSP URL) cho MỌI camera status='active' của org.
 * Dùng cho probe loop mở rộng — probe cả camera chưa recording để UI hiện
 * trạng thái Online/Offline realtime. Trước đây probe chỉ chạy cho camera
 * đang recording → camera cấu hình xong nhưng chưa Start bị hiện "Offline"
 * do last_probe_at cũ (không có nhịp probe nào chạy).
 *
 * Backend endpoint chung với fetchRecordingCredentials: khi all_active=true
 * bỏ qua camera_ids và trả tất cả camera active của org.
 */
export async function fetchAllActiveCameraCredentials(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
}): Promise<CredentialItem[]> {
  const body = JSON.stringify({ camera_ids: [], all_active: true });
  const res = await fetchWithRetrySigned(
    `${params.backendUrl}${AGENT_API_PATHS.recordingCredentials}`,
    () => ({
      method: "POST",
      headers: signBodyV2({
        agentCode: params.agentCode,
        agentSecret: params.agentSecret,
        method: "POST",
        canonicalPath: AGENT_API_PATHS.recordingCredentials,
        body,
      }),
      body,
      redirect: "manual",
    }),
  );
  if (!res.ok) {
    throw new Error(`recording-credentials all_active ${res.status}`);
  }
  const json = (await res.json()) as { ok: boolean; items?: CredentialItem[] };
  return json.items ?? [];
}

export type RecordingStatusEvent =
  | "recording"
  | "stopped"
  | "error"
  | "degraded"
  | "error_prolonged"
  | "credentials_unavailable";

export async function postRecordingStatus(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  sessionId: string;
  cameraId: string;
  status: RecordingStatusEvent;
  errorMessage?: string | null;
  pid?: number | null;
  codecDetected?: string | null;
  codecWarning?: string | null;
}): Promise<{ ok: boolean; status: number }> {
  const body = JSON.stringify({
    session_id: params.sessionId,
    camera_id: params.cameraId,
    status: params.status,
    error_message: params.errorMessage ?? null,
    pid: params.pid ?? null,
    codec_detected: params.codecDetected ?? null,
    codec_warning: params.codecWarning ?? null,
  });
  try {
    const res = await fetchWithRetrySigned(
      `${params.backendUrl}${AGENT_API_PATHS.recordingStatus}`,
      () => ({
        method: "POST",
        headers: signBodyV2({
          agentCode: params.agentCode,
          agentSecret: params.agentSecret,
          method: "POST",
          canonicalPath: AGENT_API_PATHS.recordingStatus,
          body,
        }),
        body,
        redirect: "manual",
      }),
    );
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export interface SegmentFilePayload {
  camera_id: string;
  session_id: string | null;
  file_path: string;
  file_name: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
}

export interface PostRecordingFilesResult {
  ok: boolean;
  status: number;
  upserted?: number;
  collisions?: string[];
}

export async function postRecordingFiles(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  files: SegmentFilePayload[];
}): Promise<PostRecordingFilesResult> {
  const body = JSON.stringify({ files: params.files });
  try {
    const res = await fetchWithRetrySigned(
      `${params.backendUrl}${AGENT_API_PATHS.recordingFiles}`,
      () => ({
        method: "POST",
        headers: signBodyV2({
          agentCode: params.agentCode,
          agentSecret: params.agentSecret,
          method: "POST",
          canonicalPath: AGENT_API_PATHS.recordingFiles,
          body,
        }),
        body,
        redirect: "manual",
      }),
    );
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as {
      ok: boolean;
      upserted?: number;
      collisions?: string[];
    };
    return {
      ok: true,
      status: res.status,
      upserted: json.upserted,
      collisions: json.collisions,
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

export interface KnownFileEntry {
  camera_id: string;
  file_path: string;
  ended_at: string | null;
  duration_seconds: number | null;
}

export async function fetchKnownRecordingFiles(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  cameraIds: string[];
  sinceIso: string;
}): Promise<KnownFileEntry[]> {
  const body = JSON.stringify({
    camera_ids: params.cameraIds,
    since_iso: params.sinceIso,
  });
  const res = await fetchWithRetrySigned(
    `${params.backendUrl}${AGENT_API_PATHS.recordingFilesKnown}`,
    () => ({
      method: "POST",
      headers: signBodyV2({
        agentCode: params.agentCode,
        agentSecret: params.agentSecret,
        method: "POST",
        canonicalPath: AGENT_API_PATHS.recordingFilesKnown,
        body,
      }),
      body,
      redirect: "manual",
    }),
  );
  if (!res.ok) {
    throw new Error(`recording-files/known ${res.status}`);
  }
  const json = (await res.json()) as { ok: boolean; files?: KnownFileEntry[] };
  return json.files ?? [];
}

// 'skipped' cũ bỏ 2026-07-06 — ca idempotent-reuse (file _clips/ có sẵn)
// giờ gửi `done` với `generation_params.idempotent_reuse=true`. Xem cọc
// tại warehouse-agent/src/index.ts nơi post idempotent-reuse.
export type ClipOutcome = "done" | "failed" | "encoding";

export interface PostClipResultParams {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  /**
   * Safe-retry S5 2026-07-06: clip_id là identity generation. Backend
   * cập nhật row `order_proof_clips` theo id, KHÔNG upsert theo pe_id.
   * NULL chỉ cho path legacy (agent version cũ chưa deploy) — sẽ được
   * loại bỏ khi bỏ dead route 2026-07-17.
   */
  clipId: string | null;
  packingEventId: string;
  cameraId: string;
  waybillCode: string;
  outcome: ClipOutcome;
  clipPath?: string | null;
  clipName?: string | null;
  clipStartedAt?: string | null;
  clipEndedAt?: string | null;
  durationSeconds?: number | null;
  durationDriftSeconds?: number | null;
  fileSizeBytes?: number | null;
  isPartial?: boolean;
  coveredRangeLower?: string | null;
  coveredRangeUpper?: string | null;
  sourceFiles?: string[];
  errorMessage?: string | null;
  generationParams?: Record<string, unknown>;
}

export async function postClipCutResult(
  params: PostClipResultParams,
): Promise<{ ok: boolean; status: number }> {
  const body = JSON.stringify({
    clip_id: params.clipId,
    packing_event_id: params.packingEventId,
    camera_id: params.cameraId,
    waybill_code: params.waybillCode,
    outcome: params.outcome,
    clip_path: params.clipPath ?? null,
    clip_name: params.clipName ?? null,
    clip_started_at: params.clipStartedAt ?? null,
    clip_ended_at: params.clipEndedAt ?? null,
    duration_seconds: params.durationSeconds ?? null,
    duration_drift_seconds: params.durationDriftSeconds ?? null,
    file_size_bytes: params.fileSizeBytes ?? null,
    is_partial: params.isPartial ?? false,
    covered_range_lower: params.coveredRangeLower ?? null,
    covered_range_upper: params.coveredRangeUpper ?? null,
    source_files: params.sourceFiles ?? [],
    error_message: params.errorMessage ?? null,
    generation_params: params.generationParams ?? {},
  });
  try {
    const res = await fetchWithRetrySigned(
      `${params.backendUrl}${AGENT_API_PATHS.clipCutResult}`,
      () => ({
        method: "POST",
        headers: signBodyV2({
          agentCode: params.agentCode,
          agentSecret: params.agentSecret,
          method: "POST",
          canonicalPath: AGENT_API_PATHS.clipCutResult,
          body,
        }),
        body,
        redirect: "manual",
      }),
    );
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * 3c: xin signed upload URL từ backend để đẩy clip lên bucket tạm.
 * Agent KHÔNG giữ Supabase key — chỉ gọi endpoint HMAC-authed, backend
 * cấp URL.
 */
export async function fetchClipUploadUrl(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  clipId: string;
  packingEventId: string;
}): Promise<{ ok: true; signedUrl: string; bucketPath: string } | { ok: false; error: string; status: number }> {
  const body = JSON.stringify({
    clip_id: params.clipId,
    packing_event_id: params.packingEventId,
  });
  try {
    const res = await fetchWithRetrySigned(
      `${params.backendUrl}${AGENT_API_PATHS.clipUploadUrl}`,
      () => ({
        method: "POST",
        headers: signBodyV2({
          agentCode: params.agentCode,
          agentSecret: params.agentSecret,
          method: "POST",
          canonicalPath: AGENT_API_PATHS.clipUploadUrl,
          body,
        }),
        body,
        redirect: "manual",
      }),
    );
    if (!res.ok) {
      let msg = "";
      try {
        const j = (await res.json()) as { error?: string };
        msg = j.error ?? "";
      } catch {
        // ignore parse
      }
      return { ok: false, error: msg || `http_${res.status}`, status: res.status };
    }
    const j = (await res.json()) as { signed_url: string; bucket_path: string };
    return { ok: true, signedUrl: j.signed_url, bucketPath: j.bucket_path };
  } catch (err) {
    return { ok: false, error: (err as Error).message, status: 0 };
  }
}

/**
 * 3c: báo backend upload xong. Backend verify file trong bucket, update
 * order_proof_clips.bucket_path + bucket_uploaded_at.
 */
export async function notifyClipUploadComplete(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  clipId: string;
  packingEventId: string;
  fileSizeBytes: number;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const body = JSON.stringify({
    clip_id: params.clipId,
    packing_event_id: params.packingEventId,
    file_size_bytes: params.fileSizeBytes,
  });
  try {
    const res = await fetchWithRetrySigned(
      `${params.backendUrl}${AGENT_API_PATHS.clipUploadComplete}`,
      () => ({
        method: "POST",
        headers: signBodyV2({
          agentCode: params.agentCode,
          agentSecret: params.agentSecret,
          method: "POST",
          canonicalPath: AGENT_API_PATHS.clipUploadComplete,
          body,
        }),
        body,
        redirect: "manual",
      }),
    );
    if (!res.ok) {
      let msg = "";
      try {
        const j = (await res.json()) as { error?: string };
        msg = j.error ?? "";
      } catch {
        // ignore
      }
      return { ok: false, status: res.status, error: msg || `http_${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

export async function reportCommandResult(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  commandId: string;
  status: "done" | "failed";
  result?: Record<string, unknown> | null;
  error?: string | null;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const body = JSON.stringify({
    command_id: params.commandId,
    status: params.status,
    result: params.result ?? null,
    error: params.error ?? null,
  });
  const res = await fetchWithRetrySigned(
    `${params.backendUrl}${AGENT_API_PATHS.commandResult}`,
    () => ({
      method: "POST",
      headers: signBodyV2({
        agentCode: params.agentCode,
        agentSecret: params.agentSecret,
        method: "POST",
        canonicalPath: AGENT_API_PATHS.commandResult,
        body,
      }),
      body,
      redirect: "manual",
    }),
  );
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // ignore body parse errors — status alone is enough for caller
  }
  return { ok: res.ok, status: res.status, body: parsed };
}
