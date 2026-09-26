/**
 * Tên tiếng Việt của từng mục kiểm — dùng chung cho trang Tình trạng và
 * trang Sự cố. Tách khỏi trang Tình trạng ngày 26/09/2026 (đợt 4) để hai
 * trang không gọi cùng một mục kiểm bằng hai tên.
 *
 * Không import từ `checks.ts` (file đó `server-only`) — trang client dùng được.
 */
export const CHECK_LABELS: Record<string, string> = {
  supabase_egress: "Egress Supabase",
  cron_cleanup: "Cron dọn clip",
  cron_orphan_segments: "Cron dọn segment mồ côi",
  agent_heartbeat: "Kết nối agent kho",
  camera_probe: "Camera",
  recording_freshness: "Ghi hình",
  clip_failures: "Clip đơn hàng",
  unmapped_scanner: "Quét không quy được về bàn",
  vps_resources: "Ổ đĩa + RAM VPS",
  storage_usage: "Dung lượng Storage",
  warehouse_disk: "Ổ đĩa máy kho",
  config_health: "Cấu hình",
};
