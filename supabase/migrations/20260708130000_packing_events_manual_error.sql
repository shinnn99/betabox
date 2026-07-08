-- Manual error flag cho packing_events.
--
-- Nghiệp vụ: quản lý kho đánh dấu thủ công đơn quét bị lỗi
-- (đóng sai, sai người, khiếu nại từ shipper...) để lọc trong
-- /dashboard/videos và tính vào cột "Số đơn lỗi" của báo cáo
-- hiệu suất nhân sự.
--
-- Chọn field trên packing_events (không tách bảng): 1-1 với event,
-- toggle-được, không sinh lịch sử → thêm cột đơn giản + audit tối
-- thiểu (at/by). Nếu sau này cần lịch sử chuyển sang bảng riêng.

ALTER TABLE public.packing_events
  ADD COLUMN IF NOT EXISTS manual_error boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_error_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_error_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

-- Partial index cho aggregate report: WHERE manual_error = true, group
-- by (organization_id, staff_id, business_date). Kích thước nhỏ vì
-- manual_error là ngoại lệ, không phải mặc định.
CREATE INDEX IF NOT EXISTS packing_events_manual_error_report_idx
  ON public.packing_events (organization_id, staff_id, business_date)
  WHERE manual_error = true;

COMMENT ON COLUMN public.packing_events.manual_error IS
  'Quản lý kho đánh dấu thủ công đơn lỗi (khiếu nại, đóng sai, sai người). Toggle từ /dashboard/videos.';
COMMENT ON COLUMN public.packing_events.manual_error_at IS
  'Thời điểm gần nhất user toggle manual_error.';
COMMENT ON COLUMN public.packing_events.manual_error_by IS
  'User cuối cùng toggle manual_error.';
