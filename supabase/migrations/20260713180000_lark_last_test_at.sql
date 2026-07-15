-- ============================================================================
-- Lark notify — thêm cột notify_lark_last_test_at cho warehouses.
--
-- Mục tiêu: nút "Test" trong trang cấu hình thông báo cho phép quản lý bấm
-- 1 phát → gửi tin fake vào nhóm Lark → biết webhook còn OK không mà không
-- phải chờ quét đơn thật. Cột này lưu thời điểm test cuối (thành công hay
-- thất bại đều update) để UI hiển thị cột "Kiểm tra gần nhất".
--
-- KHÔNG lưu kết quả test (success/fail) trong cột này. Nếu cần chi tiết,
-- query notification_logs với event_type='connection_test' (thêm vào CHECK).
-- ============================================================================

BEGIN;

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS notify_lark_last_test_at timestamptz;

COMMENT ON COLUMN public.warehouses.notify_lark_last_test_at IS
  'Thời điểm gần nhất user bấm nút Test trên trang Cấu hình thông báo. '
  'Update dù test thành công hay thất bại — kết quả cụ thể lấy từ '
  'notification_logs (event_type=connection_test) cùng thời gian.';

-- Thêm event_type mới cho tin test — để phân biệt tin test với tin lỗi thật
-- trong notification_logs (query "thông báo gần nhất" phải loại tin test ra).
ALTER TABLE public.notification_logs
  DROP CONSTRAINT IF EXISTS notification_logs_event_type_check;

ALTER TABLE public.notification_logs
  ADD CONSTRAINT notification_logs_event_type_check CHECK (event_type IN (
    'packing_issue_duplicated',
    'packing_issue_no_active_session',
    'packing_issue_unmapped_scanner',
    'packing_issue_invalid_code',
    'connection_test'
  ));

-- Postcondition
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouses'
      AND column_name='notify_lark_last_test_at'
  ) THEN
    RAISE EXCEPTION 'lark v3 postcondition: notify_lark_last_test_at missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.notification_logs'::regclass
      AND conname='notification_logs_event_type_check'
      AND pg_get_constraintdef(oid) LIKE '%connection_test%'
  ) THEN
    RAISE EXCEPTION 'lark v3 postcondition: connection_test not in event_type CHECK';
  END IF;
END $$;

COMMIT;
