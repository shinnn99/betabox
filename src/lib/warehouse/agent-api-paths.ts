/**
 * Canonical path literals cho HMAC v2 signature.
 *
 * Agent (warehouse-agent/src/) có bản mirror riêng — không import chéo
 * client/server. Static test đối chiếu 2 bên xem `tests/agent-api-paths-mirror.test.ts`.
 *
 * Rule:
 *   - Path = exact pathname literal (không query, không host).
 *   - Route handler pass constant tương ứng vào verifyAgentRequest; không
 *     đọc path từ req.url để tránh drift.
 *   - Route mới cần thêm HMAC agent → thêm entry ở đây trước.
 */
export const AGENT_API_PATHS = {
  heartbeat: "/api/warehouse/heartbeat",
  discovery: "/api/warehouse/discovery",
  scans: "/api/warehouse/scans",
  pollCommands: "/api/agent/poll-commands",
  commandResult: "/api/agent/command-result",
  cameraProbe: "/api/agent/camera-probe",
  recordingCredentials: "/api/agent/recording-credentials",
  recordingStatus: "/api/agent/recording-status",
  recordingFiles: "/api/agent/recording-files",
  recordingFilesKnown: "/api/agent/recording-files/known",
  clipUploadUrl: "/api/agent/clip-upload-url",
  clipUploadComplete: "/api/agent/clip-upload-complete",
  clipCutResult: "/api/agent/clip-cut-result",
  verifyClipStaleMarker: "/api/agent/verify-clip-stale-marker",
  bootDeclare: "/api/agent/boot-declare",
  logEvents: "/api/agent/log-events",
} as const;

export type AgentApiPathKey = keyof typeof AGENT_API_PATHS;
export type AgentApiPath = (typeof AGENT_API_PATHS)[AgentApiPathKey];
