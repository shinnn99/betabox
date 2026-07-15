-- ============================================================================
-- Lark digest — cấu hình 3 loại digest (daily/weekly/monthly) per kho.
--
-- Digest gửi tổng hợp cuối kỳ (không realtime) — giá trị: quản lý xem
-- một tin biết cả ngày/tuần/tháng đã có bao nhiêu đơn lỗi mỗi loại + top
-- nhân viên lỗi nhiều nhất. Realtime hiện tại chỉ cảnh báo lúc còn sửa
-- được (5 phút). Digest bù nhìn tổng.
--
-- Đơn lỗi thủ công (manual_error toggle từ /dashboard/videos) KHÔNG bắn
-- realtime — user thao tác bulk 200 đơn/lần sẽ spam. Thay vào đó count
-- vào digest daily.
--
-- Kích: pg_cron schedule chạy Supabase Edge Function `lark-digest` (KHÔNG
-- gọi Vercel route: Vercel Hobby hết slot cron + lambda có thể kill giữa
-- fetch). Edge Function Deno chạy đủ lâu để hoàn thành fetch Lark.
--
-- Bật/tắt per kho — mặc định TẮT. Khi kho bật, mới gửi.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Cột config digest per kho
-- ----------------------------------------------------------------------------
ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS notify_lark_digest_daily boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_lark_digest_weekly boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_lark_digest_monthly boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.warehouses.notify_lark_digest_daily IS
  'Bật gửi digest tổng hợp cuối ngày (22:00 VN). Mặc định false — chỉ gửi khi kho bật.';
COMMENT ON COLUMN public.warehouses.notify_lark_digest_weekly IS
  'Bật gửi digest tuần (thứ 2 sáng 08:00 VN, tổng hợp tuần trước).';
COMMENT ON COLUMN public.warehouses.notify_lark_digest_monthly IS
  'Bật gửi digest tháng (ngày 1 sáng 08:00 VN, tổng hợp tháng trước).';

-- ----------------------------------------------------------------------------
-- 2. Thêm event_type digest vào CHECK
-- ----------------------------------------------------------------------------
ALTER TABLE public.notification_logs
  DROP CONSTRAINT IF EXISTS notification_logs_event_type_check;

ALTER TABLE public.notification_logs
  ADD CONSTRAINT notification_logs_event_type_check CHECK (event_type IN (
    'packing_issue_duplicated',
    'packing_issue_no_active_session',
    'packing_issue_unmapped_scanner',
    'packing_issue_invalid_code',
    'connection_test',
    'digest_daily',
    'digest_weekly',
    'digest_monthly'
  ));

-- ----------------------------------------------------------------------------
-- 3. Postcondition
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouses'
      AND column_name='notify_lark_digest_daily'
  ) THEN
    RAISE EXCEPTION 'lark digest postcondition: notify_lark_digest_daily missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.notification_logs'::regclass
      AND conname='notification_logs_event_type_check'
      AND pg_get_constraintdef(oid) LIKE '%digest_daily%'
  ) THEN
    RAISE EXCEPTION 'lark digest postcondition: digest_daily not in event_type CHECK';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- 4. pg_cron schedule — schedule sau khi Edge Function `lark-digest` được
--    deploy (chạy bằng lệnh riêng, không phải trong migration này).
--
-- Sau khi deploy edge function, apply thêm schedule bằng SQL:
--
--   SELECT cron.schedule(
--     'lark-digest-daily',
--     '0 15 * * *',  -- 22:00 VN = 15:00 UTC
--     $$
--     SELECT net.http_post(
--       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/lark-digest',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'Authorization', 'Bearer ' || current_setting('app.digest_secret')
--       ),
--       body := jsonb_build_object('period', 'daily')
--     );
--     $$
--   );
--
--   -- Weekly: thứ 2 08:00 VN = thứ 2 01:00 UTC (dow=1)
--   SELECT cron.schedule('lark-digest-weekly', '0 1 * * 1', $$ ... period='weekly' $$);
--
--   -- Monthly: ngày 1 08:00 VN = ngày 1 01:00 UTC
--   SELECT cron.schedule('lark-digest-monthly', '0 1 1 * *', $$ ... period='monthly' $$);
--
-- Không schedule trong migration này vì cần biết PROJECT_REF + secret riêng.
-- ============================================================================
