-- Chốt chạy trùng mã agent: một mã agent chỉ một tiến trình nhận lệnh.
--
-- Ca thật 17/09/2026: máy kho chạy bản agent cũ cùng mã AGENT_KHO_HN_01
-- giành mọi lệnh ghi/cắt clip của máy chạy bản mới; segment thiếu agent_id
-- nên clip không cắt được. Cloud không phân biệt được hai máy vì mã + secret
-- giống hệt.
--
-- Agent bản mới gửi agent_instance_id (body đã ký) khi hỏi lệnh. Route
-- /api/agent/poll-commands giữ phiên đang có quyền ở hai cột dưới, thuê 30
-- giây, gia hạn cùng lần ghi last_seen_at sẵn có (không thêm lượt ghi).
-- Agent bản cũ chỉ bị chặn khi đang có phiên mới giữ quyền.
--
-- Không tạo agent mới, không đổi dữ liệu có sẵn. Route chạy được cả khi
-- migration chưa áp (thiếu cột thì bỏ qua chốt).

BEGIN;

ALTER TABLE public.warehouse_agents
  ADD COLUMN IF NOT EXISTS active_instance_id uuid,
  ADD COLUMN IF NOT EXISTS active_instance_seen_at timestamptz;

COMMENT ON COLUMN public.warehouse_agents.active_instance_id IS
  'Tiến trình agent đang giữ quyền nhận lệnh (agent_instance_id). NULL = chưa agent bản mới nào giữ.';
COMMENT ON COLUMN public.warehouse_agents.active_instance_seen_at IS
  'Lần gần nhất phiên giữ quyền hỏi lệnh. Cũ hơn 30 giây thì phiên khác được nhận quyền.';

COMMIT;
