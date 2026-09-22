-- ============================================================================
-- Viewer xem thêm Báo cáo và Thiết bị kho — CHỈ XEM (chủ dự án 22/09/2026)
--
-- Thêm cho viewer:
--   report.view         → trang Báo cáo hiệu suất (và Bảng điều khiển, cùng
--                          quyền đọc số liệu)
--   station_device.view → trang Thiết bị kho: thiết bị nào ở bàn nào, cái
--                          nào mất kết nối
--
-- KHÔNG thêm quyền ghi nào: thêm/sửa/xoá/gán bàn/test/bật-tắt ghi vẫn thuộc
-- nhóm setup; trên giao diện nút hiện mờ, bấm vào chỉ báo không có quyền.
-- Cũng KHÔNG thêm packing_station.view: quyền đó mở luôn trang Tổ chức & Kho
-- và Bàn đóng hàng — ngoài phạm vi chủ dự án yêu cầu.
--
-- Chạy sau 20260921160000_role_permission_redesign.sql. Chạy lại nhiều lần
-- vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permission_matrix (role, permission_code) VALUES
  ('viewer', 'report.view'),
  ('viewer', 'station_device.view')
ON CONFLICT DO NOTHING;

COMMIT;
