-- ============================================================================
-- Lý do bỏ lượt quét — `warehouse_scan_raw_events.ignored_reason`
-- (kế hoạch VAN-HANH-NHIEU-KHO, đợt 5)
--
-- VÌ SAO CẦN: loại lỗi tệ nhất là hệ thống BIẾT lý do rồi vứt đi. Route
-- `/api/warehouse/scans` tính đúng "bàn này đặt nguồn quét là camera mà lượt
-- này đến từ súng" (hoặc ngược lại), trả cảnh báo `scan_source_disabled` cho
-- agent — rồi không lưu lại gì. Lượt quét thô vẫn được ghi nhưng không sinh
-- đơn, nên nhật ký xếp nó vào nhánh mồ côi và gắn nhãn sai hai lần: "Mã sai"
-- (mã hoàn toàn hợp lệ) và "Đang chờ xử lý" (sẽ không bao giờ được xử lý).
-- Đo 26/09/2026: 5/90 lượt không sinh đơn trong 36 giờ, cả 5 từ súng quét.
--
-- Ghi LÚC NHẬN, không suy lại lúc đọc: cấu hình nguồn quét của bàn đổi được,
-- suy lại lúc đọc là lịch sử đổi nghĩa theo cấu hình hôm nay.
--
-- NULL = lượt quét được xử lý bình thường (mọi dòng cũ). Danh sách lý do
-- đóng: thêm lý do mới phải thêm vào CHECK ở đây — và phải có câu hiển thị
-- trong nhật ký lẫn câu "cần làm" trong mục kiểm (kế hoạch 4.4).
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả. Không đụng dữ liệu cũ.
-- ============================================================================

BEGIN;

ALTER TABLE public.warehouse_scan_raw_events
  ADD COLUMN IF NOT EXISTS ignored_reason text NULL;

ALTER TABLE public.warehouse_scan_raw_events
  DROP CONSTRAINT IF EXISTS warehouse_scan_raw_events_ignored_reason_check;
ALTER TABLE public.warehouse_scan_raw_events
  ADD CONSTRAINT warehouse_scan_raw_events_ignored_reason_check
  CHECK (ignored_reason IS NULL OR ignored_reason IN ('scan_source_disabled'));

-- Mục kiểm "lượt quét bị bỏ" chỉ đọc đúng những dòng này — hiếm, nên chỉ mục
-- một phần nhỏ thay vì cả bảng lượt quét.
CREATE INDEX IF NOT EXISTS warehouse_scan_raw_events_ignored_idx
  ON public.warehouse_scan_raw_events (organization_id, scanned_at DESC)
  WHERE ignored_reason IS NOT NULL;

COMMENT ON COLUMN public.warehouse_scan_raw_events.ignored_reason IS
  'Vì sao lượt quét KHÔNG được xử lý thành đơn, ghi lúc nhận. NULL = xử lý bình thường. scan_source_disabled = nguồn quét (súng / camera) đang bị tắt ở bàn.';

COMMIT;
