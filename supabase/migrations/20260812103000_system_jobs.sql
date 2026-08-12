-- system_jobs — sổ chạy của các job nền (cron, self-check hạ tầng).
--
-- Vì sao cần:
--   Tuần 08/2026 có 3 sự cố phát hiện muộn, trong đó cron dọn clip chết
--   âm thầm 5 ngày sau khi chuyển Vercel → VPS (lịch cũ nằm trong
--   vercel.json, VPS không đọc file đó). Không ai biết vì không có chỗ
--   nào ghi lại "job này chạy lần cuối lúc nào, có ok không".
--   Bảng này là nguồn chân lý cho câu hỏi đó: mỗi lần job chạy ghi đúng
--   1 dòng, kể cả khi job lỗi. "Không có dòng mới" chính là tín hiệu
--   cảnh báo — im lặng phải đọc được, không được lẫn với bình thường.
--
-- KHÔNG có organization_id — CỐ Ý:
--   Đây là bảng hạ-tầng cấp nền tảng, không phải dữ liệu khách. Job chạy
--   toàn hệ (cron dọn clip mọi org). Vì vậy `detail` KHÔNG được chứa dữ
--   liệu định danh của khách (mã đơn, đường dẫn file, tên nhân viên) —
--   chỉ số đếm, mã lỗi, mốc thời gian. Ai thêm field vào `detail` phải
--   giữ ranh giới này, nếu không bảng platform-global sẽ vô tình thành
--   kho dữ liệu tenant không có đường lọc org.
--
-- Ghi: service_role (admin client) từ route job. Không ai khác ghi.

CREATE TABLE public.system_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok BOOLEAN NOT NULL,
  detail JSONB,
  duration_ms INT
);

-- Truy vấn duy nhất mà cảnh báo cần: "lần chạy gần nhất của job X".
-- ORDER BY ran_at DESC LIMIT 1 với job_name cố định → index này phục vụ
-- đúng shape đó, không cần scan.
CREATE INDEX system_jobs_name_time_idx
  ON public.system_jobs (job_name, ran_at DESC);

COMMENT ON TABLE public.system_jobs IS
  'Sổ chạy job nền (cron dọn clip, self-check hạ tầng). Platform-global, '
  'KHÔNG có organization_id — detail không được chứa dữ liệu định danh '
  'khách. Ghi qua service_role; đọc qua route gated requirePlatformRole.';

ALTER TABLE public.system_jobs ENABLE ROW LEVEL SECURITY;

-- RLS: chỉ platform admin đọc.
--
-- Khác với platform_admins/platform_audit_log/agent_log_events (RLS bật +
-- KHÔNG policy = default-deny hoàn toàn, chỉ service_role đọc được), bảng
-- này có policy SELECT thật cho platform admin. Lý do khác biệt:
--   * Không đệ quy: policy gọi app.is_platform_admin(), mà bảng bị hàm đó
--     đọc là platform_admins — bảng khác, không tự-gọi chính mình.
--   * Không đụng vế A3 (20260704120000): A3 bỏ nhánh `is_platform_admin()
--     OR ...` khỏi SELECT của 22 bảng TENANT vì bypass đó bỏ qua giới hạn
--     org-token khi platform admin impersonate. Bảng này không có cột org
--     nào để giới hạn, nên không có cửa cross-tenant nào để hở.
-- Tenant (authenticated có org) không match → 0 row. anon không có policy
-- → 0 row.
CREATE POLICY "system_jobs platform admin select" ON public.system_jobs
  FOR SELECT TO authenticated
  USING (app.is_platform_admin());

-- Không policy INSERT/UPDATE/DELETE: ghi chỉ qua service_role (bypass RLS).
-- Platform admin đọc-được nhưng không sửa-được sổ chạy job.
