-- ============================================================================
-- Viewer xem MỌI trang (trừ Quản lý hệ thống) — CHỈ XEM; ẩn thông tin nhạy cảm
-- (chủ dự án 22/09/2026)
--
-- Viewer thêm các quyền XEM còn thiếu:
--   report.view                     → Bảng điều khiển, Báo cáo hiệu suất
--   packing_station.view            → Tổ chức & Kho, Bàn đóng hàng
--   station_device.view             → Thiết bị kho, Máy trạm kho
--   station_device_assignment.view  → thiết bị nào gắn bàn nào
--
-- KHÔNG có trang Quản lý hệ thống: không user.*, không audit.view, không
-- warehouse.update (Cấu hình kho). KHÔNG có quyền ghi nào — nút thao tác trên
-- mọi trang hiện mờ, bấm vào chỉ báo không có quyền.
--
-- Quyền mới `sensitive.view` — xem thông tin có thể bị lợi dụng để tác động
-- tới người khác / hệ thống: IP, cổng, RTSP, username, MAC của camera; SĐT,
-- email nhân viên. Cấp cho MỌI vai trò trừ viewer (không ai đang dùng mất gì).
-- API tự che các trường này với người thiếu quyền. (URL webhook Lark và mã QR
-- vào ca đi theo quyền sửa tương ứng, không theo mã này.)
--
-- Chạy sau 20260921160000_role_permission_redesign.sql. Chạy lại nhiều lần
-- vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permission_matrix (role, permission_code) VALUES
  ('viewer', 'report.view'),
  ('viewer', 'packing_station.view'),
  ('viewer', 'station_device.view'),
  ('viewer', 'station_device_assignment.view'),
  ('owner', 'sensitive.view'),
  ('admin', 'sensitive.view'),
  ('warehouse_manager', 'sensitive.view'),
  ('shift_leader', 'sensitive.view'),
  ('packer', 'sensitive.view')
ON CONFLICT DO NOTHING;

-- Chốt: viewer tuyệt đối không có mã nhạy cảm / quản lý hệ thống / ghi.
DELETE FROM public.role_permission_matrix
WHERE role::text = 'viewer'
  AND (
    permission_code = 'sensitive.view'
    OR permission_code LIKE 'user.%'
    OR permission_code = 'audit.view'
    OR permission_code ~ '\.(create|update|delete|archive|manage|generate|invite|control|test|operate|regenerate|force_end|camera_setup)$'
  );

COMMIT;
