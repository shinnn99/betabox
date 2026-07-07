-- ============================================================================
-- B1.4 (Lát B rollout HMAC v2): per-agent enforcement column.
--
-- Cột nullable timestamp thay boolean vì:
--   - NULL  → agent nhận cả v1 và v2 (default backward-compat).
--   - now() → enforce ngay (chỉ nhận v2, v1 reject).
--   - future → schedule enforcement (kích hoạt tự động khi đến giờ).
-- Rollback = set NULL, không cần deploy code.
--
-- Backend đọc cột trong `verifyAgentRequest` sau khi signature verify OK:
--   IF agent.hmac_v2_enforced_at IS NOT NULL
--      AND agent.hmac_v2_enforced_at <= now()
--      AND verdict.version = 'v1'
--   THEN reject 401 (log agent_id + route + version, không log secret).
--
-- Rollout Lát B2 (bằng hand, không hardcode trong migration):
--   1. Deploy backend + agent v0.4.
--   2. Xác nhận telemetry agent chỉ còn v2 trên mọi route (24h).
--   3. `UPDATE warehouse_agents SET hmac_v2_enforced_at = now() WHERE id = <agent>;`
--   4. Chạy 3 negative test tay + rollback test.
-- ============================================================================

BEGIN;

ALTER TABLE public.warehouse_agents
  ADD COLUMN IF NOT EXISTS hmac_v2_enforced_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.warehouse_agents.hmac_v2_enforced_at IS
  'B1.4: khi <= now() enforce HMAC v2 cho agent này (v1 request bị reject). NULL = accept cả v1+v2.';

-- Postcondition guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'warehouse_agents'
      AND column_name = 'hmac_v2_enforced_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'b1.4 postcondition failed: hmac_v2_enforced_at not created / wrong type';
  END IF;
END $$;

COMMIT;
