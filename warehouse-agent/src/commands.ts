import { signBody } from "./signing";

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
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  const res = await fetch(`${params.backendUrl}/api/agent/poll-commands`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
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
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  const res = await fetch(`${params.backendUrl}/api/agent/poll-commands`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
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
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  const res = await fetch(`${params.backendUrl}/api/agent/recording-credentials`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
  if (!res.ok) {
    throw new Error(`recording-credentials ${res.status}`);
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
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  try {
    const res = await fetch(`${params.backendUrl}/api/agent/recording-status`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
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
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  try {
    const res = await fetch(`${params.backendUrl}/api/agent/recording-files`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
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
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  const res = await fetch(`${params.backendUrl}/api/agent/recording-files/known`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
  if (!res.ok) {
    throw new Error(`recording-files/known ${res.status}`);
  }
  const json = (await res.json()) as { ok: boolean; files?: KnownFileEntry[] };
  return json.files ?? [];
}

export type ClipOutcome = "done" | "failed" | "skipped" | "encoding";

export interface PostClipResultParams {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
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
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  try {
    const res = await fetch(`${params.backendUrl}/api/agent/clip-cut-result`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
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
  packingEventId: string;
}): Promise<{ ok: true; signedUrl: string; bucketPath: string } | { ok: false; error: string; status: number }> {
  const body = JSON.stringify({ packing_event_id: params.packingEventId });
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  try {
    const res = await fetch(`${params.backendUrl}/api/agent/clip-upload-url`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
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
  packingEventId: string;
  fileSizeBytes: number;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const body = JSON.stringify({
    packing_event_id: params.packingEventId,
    file_size_bytes: params.fileSizeBytes,
  });
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  try {
    const res = await fetch(
      `${params.backendUrl}/api/agent/clip-upload-complete`,
      {
        method: "POST",
        headers,
        body,
        redirect: "manual",
      },
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
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  const res = await fetch(`${params.backendUrl}/api/agent/command-result`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // ignore body parse errors — status alone is enough for caller
  }
  return { ok: res.ok, status: res.status, body: parsed };
}
