-- Retention theo org: số ngày giữ video segment gốc trước khi cleanup xóa.
--
-- Đặt ở org (không phải agent) vì:
--   * Kho khác nhau cùng công ty thường bán cùng sàn → cùng cửa sổ khiếu
--     nại → cùng retention.
--   * Hạnh cấu hình 1 lần qua dashboard, mọi agent trong org nhận qua
--     heartbeat response (không phải SSH máy kho sửa .env).
--   * Mốc 3 mở multi-agent không cần migrate (retention vẫn per-org).
--
-- Ba nơi tiêu thụ:
--   1. Agent nhận qua heartbeat response, cache xuống file local, script
--      cleanup PowerShell đọc cache (không gọi mạng lúc chạy).
--   2. Agent-side clip cutter: so segment start_time với retention để
--      phân biệt "quá hạn" (nghiệp vụ) vs "segments_missing_on_disk" (bug).
--   3. Cloud clip-resolver: khi no_segments overlap trong khoảng cần cắt,
--      query rìa retention để phân biệt "quá hạn lưu trữ" vs "camera
--      không ghi được lúc đó".
--
-- NULL = chưa cấu hình, resolver trả nhãn trung tính (KHÔNG đoán 45).
-- Default 45 áp cho org mới; org cũ (Betacom) sẽ backfill riêng sau khi
-- Hạnh chốt số theo nghiệp vụ.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS retention_days INTEGER;

COMMENT ON COLUMN public.organizations.retention_days IS
  'Số ngày giữ video segment gốc trước khi cleanup xóa. Cấu hình qua dashboard, agent nhận qua heartbeat response và cache local. NULL = chưa cấu hình, resolver không khẳng định "quá hạn".';

-- Chấp nhận range hợp lý: 7-365 ngày. Dưới 7 rủi ro mất bằng chứng ngay;
-- trên 365 vô nghĩa (không sàn nào cho khiếu nại quá 1 năm) + ổ đầy.
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_retention_days_range
  CHECK (retention_days IS NULL OR (retention_days >= 7 AND retention_days <= 365));
