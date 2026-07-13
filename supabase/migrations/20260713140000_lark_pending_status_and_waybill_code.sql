-- ============================================================================
-- Lark notify — sửa 2 lỗi thiết kế đã bắt trong review:
--
--   (2) Waybill của row suppressed đang bị PARSE từ cột `message` — đổi format
--       text sẽ vỡ âm thầm. Thêm cột `waybill_code` (nullable) để lấy có cấu
--       trúc, không parse.
--
--   (3) Row 'sent' đang ghi PREEMPTIVE trước fetch. Lambda kill giữa fetch →
--       DB nói sent nhưng Lark không nhận → không đo được `after()` có cứu.
--       Thêm status 'pending'; flow mới: pending → fetch → sent/failed.
--       Row kẹt 'pending' > N phút = bằng chứng after() không cứu.
--
-- UNIQUE index đã có với WHERE status IN ('sent','failed') — mở rộng để
-- 'pending' cũng chiếm slot (cùng 1 tin cho 1 cửa sổ, dù đang gửi hay đã gửi).
--
-- KHÔNG chạy migration này lên shared DB trong phiên này.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Cột waybill_code
-- ----------------------------------------------------------------------------
ALTER TABLE public.notification_logs
  ADD COLUMN IF NOT EXISTS waybill_code text;

COMMENT ON COLUMN public.notification_logs.waybill_code IS
  'Waybill code của lỗi. Query "5 phút qua còn mã X, Y, Z" đọc cột này ở '
  'các row suppressed. Nullable: có thể null với invalid_code (mã sai).';

-- ----------------------------------------------------------------------------
-- 2. Thêm 'pending' vào CHECK status
-- ----------------------------------------------------------------------------
ALTER TABLE public.notification_logs
  DROP CONSTRAINT IF EXISTS notification_logs_status_check;

ALTER TABLE public.notification_logs
  ADD CONSTRAINT notification_logs_status_check CHECK (status IN (
    'pending',    -- Claim slot trước fetch. Row kẹt pending > N phút =
                  -- bằng chứng after() không cứu (lambda kill giữa fetch).
    'sent',       -- Fetch trả 2xx OK. Đây mới là tin ĐÃ ra Lark.
    'failed',     -- Fetch trả non-2xx hoặc network error.
    'suppressed', -- Trong cửa sổ đã có tin → không gửi, chỉ đếm.
    'disabled'    -- Kho không config webhook hoặc notify_lark_enabled=false.
  ));

-- ----------------------------------------------------------------------------
-- 3. Mở rộng UNIQUE để 'pending' cũng chiếm slot cửa sổ
-- ----------------------------------------------------------------------------
-- Nếu 'pending' KHÔNG chiếm slot → 2 request đồng thời cùng cửa sổ đều
-- ghi 'pending' → 2 fetch → 2 tin Lark = SPAM. Phải giữ nguyên đảm bảo
-- "1 tin/1 cửa sổ" từ MOMENT claim.
DROP INDEX IF EXISTS public.notification_logs_window_uniq;
CREATE UNIQUE INDEX notification_logs_window_uniq
  ON public.notification_logs (warehouse_id, event_type, window_start)
  WHERE status IN ('pending', 'sent', 'failed');

-- ----------------------------------------------------------------------------
-- 4. Postcondition
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='notification_logs'
      AND column_name='waybill_code'
  ) THEN
    RAISE EXCEPTION 'lark v2 postcondition: waybill_code column missing';
  END IF;

  -- Verify CHECK cho phép 'pending'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.notification_logs'::regclass
      AND conname = 'notification_logs_status_check'
      AND pg_get_constraintdef(oid) LIKE '%pending%'
  ) THEN
    RAISE EXCEPTION 'lark v2 postcondition: pending not in status CHECK';
  END IF;

  -- Verify UNIQUE index bao gồm 'pending'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='notification_logs'
      AND indexname='notification_logs_window_uniq'
      AND indexdef LIKE '%pending%'
  ) THEN
    RAISE EXCEPTION 'lark v2 postcondition: UNIQUE index missing pending';
  END IF;
END $$;

COMMIT;
