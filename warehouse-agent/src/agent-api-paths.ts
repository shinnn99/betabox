/**
 * MIRROR của src/lib/warehouse/agent-api-paths.ts (backend).
 *
 * Agent không import từ backend workspace để không kéo "server-only"
 * dependency vào bundle pkg. Static test `tests/agent-api-paths-mirror.test.ts`
 * so sánh 2 map, fail nếu lệch — không đổi bên nào mà quên bên kia.
 *
 * Rule: mọi request agent HMAC-signed dùng đúng constant ở đây. Không nối
 * chuỗi ad-hoc. Route mới → thêm cả 2 bên rồi mới migrate.
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
