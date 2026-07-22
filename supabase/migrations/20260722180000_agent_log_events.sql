-- Log từ xa bản tối thiểu: agent push WARN/ERROR lên cloud, Hạnh đọc bằng SQL.
--
-- Vì sao cần:
--   * Kho khách ở xa, không có TeamViewer, agent hỏng = Hạnh mù.
--   * Bản đầy đủ có dashboard tab + lọc + digest — hoãn tới khi biết cần
--     lọc gì. Bản này chỉ ghi + query.
--
-- Retention 30 ngày cứng: log không phải bằng chứng lâu dài, đủ để chẩn
-- đoán sự cố tuần này. Cleanup pg_cron dài hạn (chưa code, theo dõi kích
-- cỡ bảng vài tuần trước khi thêm cron).
--
-- KHÔNG RLS: service_role only. Agent gửi qua endpoint HMAC (proxy path
-- whitelist). Owner khách đọc bằng SQL trên Supabase Dashboard (chỉ Hạnh
-- có).

CREATE TABLE public.agent_log_events (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES public.warehouse_agents(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('warn', 'error')),
  message TEXT NOT NULL,
  emitted_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index chính: query "log gần đây per agent theo level".
CREATE INDEX agent_log_events_agent_time_idx
  ON public.agent_log_events (agent_id, emitted_at DESC);

-- Index phụ: query cross-agent per org (Hạnh xem toàn Betacom).
CREATE INDEX agent_log_events_org_time_idx
  ON public.agent_log_events (organization_id, emitted_at DESC);

COMMENT ON TABLE public.agent_log_events IS
  'Log WARN/ERROR từ warehouse agent. Bản tối thiểu 2026-07-22 — không dashboard, query SQL. Retention theo dõi.';

ALTER TABLE public.agent_log_events ENABLE ROW LEVEL SECURITY;
-- Không policy = default-deny với authenticated. service_role bypass RLS.
