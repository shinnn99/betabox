/**
 * Pure derivation của recording UI state theo agent-pattern.
 * Tách khỏi route để test được không phụ thuộc Next.
 *
 * Ba nhánh cơ bản:
 *   1. status='recording' + heartbeat tươi + agent online → 'recording'.
 *   2. status='recording' + heartbeat stale/agent offline → 'agent_disconnected'.
 *      Không nhảy sang 'error' — agent hiccup ngắn vẫn ghi.
 *   3. status='stopped' → 'stopped'.
 *   4. status='error' → 'error' (agent xác nhận qua báo error thật).
 *
 * B2 CRIT-2 mở rộng:
 *   5. status='connection_lost' (reaper flip vì mất heartbeat > 15 phút) →
 *      'agent_disconnected'. Poll rescue sẽ kéo về 'recording' khi agent
 *      reconnect. Không nhảy sang 'error' hay 'stopped'.
 */

const DEFAULT_SESSION_HEARTBEAT_STALE_MS = 90_000;
const DEFAULT_AGENT_ONLINE_STALE_MS = 60_000;

export type RecordingUiState =
  | "recording"
  | "agent_disconnected"
  | "stopped"
  | "error"
  | "unknown";

export interface DeriveUiStateInput {
  sessionStatus: string | null;
  sessionHeartbeatAt: string | null;
  agentLastSeenAt: string | null;
  now: number;
  sessionHeartbeatStaleMs?: number;
  agentOnlineStaleMs?: number;
}

export function deriveUiState(input: DeriveUiStateInput): RecordingUiState {
  const sessionStaleMs =
    input.sessionHeartbeatStaleMs ?? DEFAULT_SESSION_HEARTBEAT_STALE_MS;
  const agentStaleMs =
    input.agentOnlineStaleMs ?? DEFAULT_AGENT_ONLINE_STALE_MS;

  if (!input.sessionStatus) return "unknown";
  if (input.sessionStatus === "stopped") return "stopped";
  if (input.sessionStatus === "error") return "error";
  // B2 CRIT-2: reaper flip 'recording' → 'connection_lost' khi mất
  // heartbeat > 15 phút. UI mapping giống 'agent_disconnected'.
  if (input.sessionStatus === "connection_lost") return "agent_disconnected";
  if (input.sessionStatus === "recording") {
    const hbAgeMs = input.sessionHeartbeatAt
      ? input.now - Date.parse(input.sessionHeartbeatAt)
      : Infinity;
    const agentAgeMs = input.agentLastSeenAt
      ? input.now - Date.parse(input.agentLastSeenAt)
      : Infinity;
    if (hbAgeMs > sessionStaleMs || agentAgeMs > agentStaleMs) {
      return "agent_disconnected";
    }
    return "recording";
  }
  return "unknown";
}
