// "Trạng thái online" của camera — nguồn chân lý duy nhất cho mọi UI
// hiển thị "camera online / offline / mất kết nối kho".
//
// TRƯỚC ĐÂY: /api/dashboard/overview đọc thẳng cameras.status ("active" =
// LIVE) trong khi /api/devices đã tính state real-time từ probe + agent
// heartbeat. Hai chỗ phân kỳ → dashboard nói "LIVE" trong khi bảng thiết
// bị nói "Mất kết nối kho" cho cùng 1 camera. Fix: cả 2 route dùng helper
// này để không lệch nhau nữa.
//
// BA cột heartbeat/probe, đừng dùng lẫn:
//   - warehouse_agents.last_seen_at (agent còn sống, 60s ngưỡng)
//   - camera_recording_sessions.last_heartbeat_at (session đang ghi, 90s)
//   - cameras.last_probe_at (camera nghe RTSP port, 90s)

export const AGENT_ONLINE_STALE_MS = Number(
  process.env.AGENT_ONLINE_STALE_MS ?? 60_000,
);
export const CAMERA_PROBE_STALE_MS = Number(
  process.env.CAMERA_PROBE_STALE_MS ?? 90_000,
);

/**
 * "Trạng thái kết nối camera" — bốn nhánh. Kết hợp cameras.last_probe_at
 * + last_probe_ok + agent.last_seen_at + hasRecordingIntent để KHÔNG dồn
 * mọi ca stale thành "chưa rõ" — mình có agent.last_seen_at để phân
 * biệt agent-chết vs camera-chết, dùng nó.
 *   - probe tươi + ok=true → online
 *   - probe tươi + ok=false → offline (agent ping được, camera không nghe)
 *   - probe stale + agent sống → offline (agent chạy mà không tới cam)
 *   - probe stale + agent chết → warehouse_disconnected (không đổ lỗi cam)
 *   - chưa có probe (last_probe_at=null):
 *       + có session recording (camera đang được yêu cầu ghi) + agent
 *         chết → warehouse_disconnected (agent muốn probe mà không probe
 *         được vì agent chết — nhất quán với ca camera-đã-probe cùng
 *         hoàn cảnh, không hiển thị "Đã cấu hình" nói dối "ổn").
 *       + có session recording + agent sống → nhánh này hiếm (agent
 *         vừa spawn xong chưa kịp probe nhịp đầu) → not_probed (tối đa
 *         30s sẽ có probe đầu tiên).
 *       + không có session recording → not_probed (camera chưa được
 *         yêu cầu ghi, không cần probe — UI hiển thị snapshot
 *         cameras.status).
 */
export type CameraOnlineState =
  | "online"
  | "offline"
  | "warehouse_disconnected"
  | "not_probed";

export function deriveCameraOnlineState(input: {
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  agentLastSeenAt: string | null;
  hasRecordingIntent: boolean;
  now: number;
}): CameraOnlineState {
  const agentOffline = input.agentLastSeenAt
    ? input.now - Date.parse(input.agentLastSeenAt) > AGENT_ONLINE_STALE_MS
    : true;
  if (!input.lastProbeAt || input.lastProbeOk === null) {
    // Camera chưa từng được probe. Nếu đang được yêu cầu ghi mà agent
    // chết → warehouse_disconnected, không "Đã cấu hình" (nói dối "ổn"
    // trong khi agent thực chất chết).
    if (input.hasRecordingIntent && agentOffline) {
      return "warehouse_disconnected";
    }
    return "not_probed";
  }
  const probeAgeMs = input.now - Date.parse(input.lastProbeAt);
  const probeStale = probeAgeMs > CAMERA_PROBE_STALE_MS;
  if (!probeStale) {
    return input.lastProbeOk ? "online" : "offline";
  }
  // Stale: kết hợp agent.last_seen_at để phân biệt.
  return agentOffline ? "warehouse_disconnected" : "offline";
}
