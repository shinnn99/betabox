/**
 * Tên tiếng Việt của từng mục kiểm — MỘT nguồn cho trang Tình trạng, trang
 * Sự cố, danh sách "Cần chú ý" (status-view.ts) và cột "cái gì" của sổ —
 * để không nơi nào gọi cùng một mục kiểm bằng hai tên.
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
  unmapped_scanner: "Quét không rõ bàn",
  ignored_scans: "Lượt quét bị bỏ",
  agent_fleet: "Bản agent & hàng đợi",
  vps_resources: "Ổ đĩa + RAM VPS",
  storage_usage: "Dung lượng Storage",
  warehouse_disk: "Ổ đĩa máy kho",
  config_health: "Cấu hình",
};
