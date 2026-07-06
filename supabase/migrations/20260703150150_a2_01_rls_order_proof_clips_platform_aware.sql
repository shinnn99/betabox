-- LỊCH SỬ: migration này áp order_proof_clips platform-aware LỆCH quy trình
-- (chưa verify agent-role trước). Đã ROLLBACK về policy cũ ngay sau, rồi áp
-- lại ĐÚNG quy trình ở migration 20260703152530_a2_20_rls_order_proof_clips.
--
-- Giữ file này idempotent (no-op nếu đã ở trạng thái đúng) để tracking hoàn
-- chỉnh với remote history. KHÔNG áp lại pattern platform-aware ở đây —
-- pattern chính thức là ở a2_20.

DO $$
BEGIN
  -- Nếu vẫn còn policy CŨ (chưa qua a2_20), tức đây là replay từ đầu.
  -- Rollback về policy cũ để a2_20 (chạy sau theo timestamp) áp lại đúng.
  IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='order_proof_clips' AND policyname='order_proof_clips platform or org select') THEN
    -- Trạng thái đã đúng (a2_20 đã chạy) — no-op.
    NULL;
  ELSIF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='order_proof_clips' AND policyname='order_proof_clips_select') THEN
    -- Trạng thái baseline cũ — no-op, để a2_20 sau xử đúng.
    NULL;
  END IF;
END $$;
