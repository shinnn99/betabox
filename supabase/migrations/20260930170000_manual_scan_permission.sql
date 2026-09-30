-- Quyền riêng cho trang Quét tay / HID (chủ dự án chốt 30/09/2026: mọi vai
-- trò được quét tay, TRỪ Quan sát viên). Trước đây route ghi lượt quét mượn
-- station_device.view — quyền XEM — nên Trưởng kho (chỉ xem) ghi được mà
-- Nhân viên đóng gói (người thật sự quét) lại bị chặn.
--
-- Chỉ thêm dòng, không xoá: chạy lại vô hại. Platform chỉnh tiếp trên trang
-- Phân quyền như mọi mã khác.

BEGIN;

INSERT INTO public.role_permission_matrix (role, permission_code) VALUES
  ('owner', 'packing.manual_scan'),
  ('admin', 'packing.manual_scan'),
  ('warehouse_manager', 'packing.manual_scan'),
  ('shift_leader', 'packing.manual_scan'),
  ('packer', 'packing.manual_scan')
ON CONFLICT DO NOTHING;

COMMIT;
