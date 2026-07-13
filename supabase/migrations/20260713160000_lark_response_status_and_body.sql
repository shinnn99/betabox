-- ============================================================================
-- Lark notify — bổ sung response_status + response_body vào notification_logs.
--
-- Bằng chứng vì sao cần:
--   BetacomEdu 3-4 tháng chạy với success=true GIẢ 100%: log pg_net status
--   202 ngay khi enqueue http_post, KHÔNG đợi Lark trả về. Response body
--   chỉ có "pg_net request_id=... payload=..." — KHÔNG chứa response Lark
--   thật. Không ai biết có bao nhiêu tin thật sự tới nhóm.
--
--   Betacom scans tránh hố này: fetch trực tiếp Lark (không qua pg_net) +
--   ghi response_status HTTP + response_body raw. Vế 2 verify production
--   ("DB sent = số tin trong nhóm Lark") diễn giải được: nếu DB sent mà
--   Lark không nhận → đọc response_body biết lý do (invalid token, rate
--   limit, format sai...).
--
-- Đường B (thận trọng) — logic phán quyết:
--   HTTP 2xx + body có `code === 0` → sent.
--   HTTP 2xx + body có `code !== 0` → failed.
--   HTTP 2xx + body không có `code` field / không parse JSON → sent
--     (fallback HTTP status, không tệ hơn hành vi cũ).
--   HTTP non-2xx → failed.
-- ============================================================================

BEGIN;

ALTER TABLE public.notification_logs
  ADD COLUMN IF NOT EXISTS response_status integer,
  ADD COLUMN IF NOT EXISTS response_body text;

COMMENT ON COLUMN public.notification_logs.response_status IS
  'HTTP status Lark trả về (200, 401, 5xx...). NULL nếu network error trước '
  'khi có response (DNS fail, timeout, abort).';

COMMENT ON COLUMN public.notification_logs.response_body IS
  'Raw response body Lark trả (cap 2000 chars). Debug: nếu DB status=sent '
  'mà nhóm Lark không có tin → đọc field này biết vì sao (code != 0, ...). '
  'NULL nếu network error.';

COMMIT;
