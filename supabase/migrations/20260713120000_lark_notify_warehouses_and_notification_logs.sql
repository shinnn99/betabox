-- ============================================================================
-- Lark notification MVP đợt 1 — Betacom nội bộ dùng, chưa giao khách.
--
-- Mục tiêu: bot Lark bắn realtime vào nhóm quản lý kho khi packing_events có
-- status bất thường (duplicated / no_active_session / unmapped_scanner /
-- invalid_code). Cắt việc quản lý phải tự mở dashboard kiểm cuối ngày.
--
-- Đợt 1 KHÔNG có: digest cuối ngày/tuần/tháng (đợi 1-2 tuần dùng thật rồi
-- biết định dạng cần gì); Zalo staff DM (plan outdated, chưa quyết); UI cảnh
-- báo kho chưa cấu hình (hoãn đợt 2 khi giao khách; Betacom vài kho + Hạnh
-- tự cấu hình, rủi ro "an toàn giả" thấp — thay bằng query kiểm).
--
-- Cạnh cứng đợt 1:
--   1. Fire-and-forget: hook không chặn đường quét — Lark chậm/down không
--      được làm chậm nhân viên quét hàng.
--   2. Gộp cửa sổ 5 phút per (warehouse_id, event_type) — chống spam khi
--      camera rớt / lỗi liên tiếp. Cơ chế: window_start làm tròn xuống mốc
--      5 phút; UNIQUE (warehouse_id, event_type, window_start) chống race
--      2 request đồng thời (cùng pattern consumeNonce HMAC v2).
--   3. Cross-tenant: webhook lấy từ warehouses trong CÙNG org của sự kiện
--      — không tin warehouse_id trần. Verify script nửa âm phải chứng minh
--      org A → 0 call webhook org B.
--   4. Fail-safe im lặng: kho chưa cấu hình webhook → không gửi, không throw
--      lên đường quét.
--
-- Đặt cột trên warehouses (KHÔNG fallback organizations):
--   - Direction 2026-07-04/07 vừa drop 5 cột metadata khỏi organizations
--     (giữ organizations siêu-gọn).
--   - Thông báo đơn lỗi thuộc về kho, không phải org — nhóm Lark theo đội kho.
--   - Fail-safe: kho không config → tắt cho kho đó, tốt hơn bắn nhầm nhóm.
--
-- notification_logs có cột `channel` (giá trị 'lark' bây giờ) — không phải
-- abstraction đa kênh, chỉ là 1 cột enum để sau thêm 'zalo'/'telegram' rẻ.
-- KHÔNG xây adapter interface trước-cần.
--
-- KHÔNG chạy migration này lên shared DB trong phiên này.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Cột webhook trên warehouses
-- ----------------------------------------------------------------------------
ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS notify_lark_webhook_url text,
  ADD COLUMN IF NOT EXISTS notify_lark_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.warehouses.notify_lark_webhook_url IS
  'Lark group webhook URL cho kho này. NULL = kho chưa cấu hình, fail-safe im lặng (không gửi). '
  'Không fallback org — direction "organizations siêu-gọn" 2026-07-04/07.';

COMMENT ON COLUMN public.warehouses.notify_lark_enabled IS
  'Master toggle Lark notify cho kho. false = kho off tạm thời dù có webhook. '
  'default false — kho mới tạo không tự bật khi chưa cấu hình.';

-- Sanity check URL shape (nếu có): phải https:// và host lark-like. Không
-- validate chặt để tránh false-negative với subdomain lạ, chỉ chặn giá trị
-- rõ ràng sai (rỗng, không phải URL).
ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_notify_lark_webhook_url_shape CHECK (
    notify_lark_webhook_url IS NULL
    OR (
      char_length(notify_lark_webhook_url) BETWEEN 20 AND 2048
      AND notify_lark_webhook_url LIKE 'https://%'
    )
  );

-- ----------------------------------------------------------------------------
-- 2. Bảng notification_logs
-- ----------------------------------------------------------------------------
-- Nguồn chân lý gộp cửa sổ: check "5 phút qua đã có tin cho (warehouse, event)
-- chưa" bằng query bảng này (KHÔNG dùng in-memory — Vercel serverless, Map
-- module-level không chia sẻ giữa lambda instance).
--
-- Cột window_start: mốc 5 phút được làm tròn xuống ở TS trước khi INSERT.
-- UNIQUE (warehouse_id, event_type, window_start) WHERE status IN
-- ('sent','failed') làm 2 việc:
--   a. Chống race 2 request đồng thời trong cùng cửa sổ (pattern nonce).
--   b. Đóng vai trò "đã gửi tin cho cửa sổ này chưa" — INSERT thành công =
--      cửa sổ mới, claim slot, gửi. Duplicate 23505 = cửa sổ đã có tin,
--      INSERT row 'suppressed' riêng (không chiếm slot) để đếm.
-- suppressed/disabled không chiếm slot → có thể nhiều row cùng cửa sổ.
--
-- suppressed_count: đếm số lỗi bị nén trong cửa sổ, đưa vào tin đầu tiên của
-- cửa sổ tiếp theo ("5 phút qua còn N đơn lỗi khác"). Tin đầu cửa sổ mới đọc
-- suppressed_count của cửa sổ TRƯỚC.

CREATE TABLE IF NOT EXISTS public.notification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('lark')),
  event_type text NOT NULL CHECK (event_type IN (
    'packing_issue_duplicated',
    'packing_issue_no_active_session',
    'packing_issue_unmapped_scanner',
    'packing_issue_invalid_code'
  )),
  -- Mốc 5 phút làm tròn xuống. Cùng (warehouse, event_type, window_start) →
  -- cùng cửa sổ. UNIQUE bên dưới.
  window_start timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN (
    'sent',           -- Gửi thành công, provider trả OK.
    'failed',         -- Gọi Lark lỗi (network/HTTP non-2xx).
    'suppressed',     -- Trong cửa sổ đã có tin → không gửi, chỉ đếm.
    'disabled'        -- Kho không config webhook hoặc notify_lark_enabled=false.
  )),
  -- Payload gửi (dùng cho debug + audit). Không nhét PII quá mức: chỉ waybill
  -- code + status + timestamp — không có tên nhân viên, không có ảnh.
  message text,
  -- Số lỗi bị nén tính đến khi tin này được gửi. Chỉ ý nghĩa với status='sent';
  -- các status khác ghi 0.
  suppressed_count integer NOT NULL DEFAULT 0,
  -- Error từ Lark hoặc lớp fetch (timeout, DNS, 5xx). NULL nếu status != failed.
  error_message text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE chống race + đánh dấu "đã có tin gửi cho cửa sổ này". CHỈ status
-- 'sent'/'failed' chiếm slot (đã cố gửi 1 tin cho cửa sổ này).
--   - 'suppressed' KHÔNG chiếm slot → có thể có nhiều row suppressed/cửa sổ,
--     mỗi row đếm 1 lỗi bị nén. Đếm bằng COUNT khi tính prev_suppressed.
--   - 'disabled' KHÔNG chiếm slot → kho bật lại giữa cửa sổ, tin mới đi được.
CREATE UNIQUE INDEX IF NOT EXISTS notification_logs_window_uniq
  ON public.notification_logs (warehouse_id, event_type, window_start)
  WHERE status IN ('sent', 'failed');

-- Query gộp: "cửa sổ (warehouse, event) gần nhất đã sent chưa"
-- + "cửa sổ trước có bao nhiêu suppressed để đưa vào tin mới".
CREATE INDEX IF NOT EXISTS notification_logs_lookup_idx
  ON public.notification_logs (warehouse_id, event_type, window_start DESC);

-- ----------------------------------------------------------------------------
-- 3. RLS + privileges — default deny, service_role only
-- ----------------------------------------------------------------------------
ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;
-- KHÔNG policy authenticated/anon → default deny.

REVOKE ALL ON TABLE public.notification_logs FROM PUBLIC;
REVOKE ALL ON TABLE public.notification_logs FROM anon;
REVOKE ALL ON TABLE public.notification_logs FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.notification_logs TO service_role;

COMMENT ON TABLE public.notification_logs IS
  'Log mọi lượt attempt gửi thông báo Lark (sent/failed/suppressed/disabled). '
  'Cột window_start + UNIQUE (warehouse, event_type, window_start) làm nguồn '
  'chân lý gộp cửa sổ 5 phút. Debug + audit. Service_role only.';

-- ----------------------------------------------------------------------------
-- 4. Postcondition guards
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses'
      AND column_name = 'notify_lark_webhook_url'
  ) THEN
    RAISE EXCEPTION 'lark postcondition: warehouses.notify_lark_webhook_url missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses'
      AND column_name = 'notify_lark_enabled'
  ) THEN
    RAISE EXCEPTION 'lark postcondition: warehouses.notify_lark_enabled missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'notification_logs'
  ) THEN
    RAISE EXCEPTION 'lark postcondition: notification_logs table missing';
  END IF;

  -- RLS phải bật.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'notification_logs'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'lark postcondition: RLS not enabled on notification_logs';
  END IF;

  -- anon/authenticated không có INSERT (chống ghi ngoài service_role).
  IF has_table_privilege('anon', 'public.notification_logs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.notification_logs', 'INSERT') THEN
    RAISE EXCEPTION 'lark postcondition: anon/authenticated has INSERT on notification_logs';
  END IF;

  -- UNIQUE index tồn tại.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'notification_logs'
      AND indexname = 'notification_logs_window_uniq'
  ) THEN
    RAISE EXCEPTION 'lark postcondition: notification_logs_window_uniq missing';
  END IF;
END $$;

COMMIT;
