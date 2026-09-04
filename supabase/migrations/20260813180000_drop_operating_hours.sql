-- Bỏ khung giờ vận hành khai báo cho từng kho.
--
-- VÌ SAO BỎ (13/08/2026, quyết định của chủ hệ):
--
--   Cột `operating_hours` thêm sáng cùng ngày (20260813040000) để mục kiểm
--   agent_heartbeat không bắn cảnh báo mỗi tối, khi kho Đại Kim tắt máy sau
--   ca. Cách làm là khai một khung giờ cứng cho từng kho.
--
--   Hỏng ở ba chỗ:
--     1. Khung 09:30–16:00 do người dựng hệ SUY RA từ 15 ngày dữ liệu ghi
--        hình, không ai ở kho xác nhận. Đó là giả định đội lốt cấu hình.
--     2. Mọi kho sau đều phải nhớ khai. Quên là bị bắn cảnh báo mỗi đêm —
--        đúng cái bẫy cột này sinh ra để tránh, chỉ dời sang khách kế tiếp.
--     3. Không có UI nào sửa được; đổi ca làm phải chạy SQL.
--
-- THAY BẰNG: đối chiếu với hoạt động nghiệp vụ thật. `packing_events` là
-- nguồn ĐỘC LẬP với agent (scan đến từ trình duyệt ở trạm đóng gói; agent
-- không ghi bảng này). Mục kiểm giờ hỏi "kho có tiếp tục đóng gói SAU KHI
-- bằng chứng ngừng về không" — hiệu số đó chính là lượng bằng chứng đã mất.
-- Kho đóng cửa thì cả hai mốc cùng dừng, hiệu số về 0, im lặng đúng mà
-- không cần biết mấy giờ và không cần ai khai gì.
--
-- Xem src/lib/system/checks.ts — evidenceLostMs().

ALTER TABLE public.warehouses
  DROP COLUMN IF EXISTS operating_hours;
