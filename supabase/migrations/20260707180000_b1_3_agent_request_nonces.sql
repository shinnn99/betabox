-- ============================================================================
-- B1.3 Phase A: HMAC replay protection — nonce table + cleanup.
--
-- Bối cảnh (review Vòng B): HMAC agent signature v1 canonical string =
-- `${timestamp}.${rawBody}`. Chỉ chống replay bằng skew ±5 phút (300s
-- window). Attacker nghe được request trong 5 phút có thể replay bất kỳ
-- lúc nào trong window. Với route idempotent (heartbeat, poll-commands)
-- vô hại; với route state-transition (recording-status stop) có thể
-- rollback state.
--
-- Fix (3 phase, rollout tương thích không downtime):
--   Phase A (migration này): tạo bảng nonce + cleanup function/pg_cron.
--   Phase B (code): protocol v2 canonical bao phủ version + agent_id +
--     method + canonical path + body_sha256 + timestamp + nonce; consume
--     nonce atomic INSERT.
--   Phase C (backend): dual-support v1 (legacy) + v2 (mới) trong window
--     rollout. Telemetry đếm v1/v2/agent. Chưa bắt buộc v2. Không tắt
--     v1 cho đến khi mọi agent đã upgrade (bằng chứng: 0 v1 request
--     trong cửa sổ observation).
--
-- Bảng warehouse_agent_request_nonces:
--   agent_id            uuid NOT NULL FK warehouse_agents(id) ON DELETE CASCADE
--                       — nonce scope by agent identity (2 agent khác có thể
--                       tình cờ dùng nonce trùng — chấp nhận, unique per agent).
--   nonce               text NOT NULL — chuỗi agent tự sinh (khuyên UUIDv4 hoặc
--                       32-byte random hex). Cap 128 chars để chống DoS bảng.
--   request_timestamp   timestamptz NOT NULL — timestamp từ header agent, dùng
--                       để debug replay window.
--   expires_at          timestamptz NOT NULL — computed = request_timestamp +
--                       skew_window + safety_buffer. Sau expires_at, cleanup
--                       xóa được.
--   created_at          timestamptz NOT NULL DEFAULT now() — khi backend consume.
--
-- Unique constraint: (agent_id, nonce) — chống replay.
-- Consume pattern: INSERT ... ON CONFLICT DO NOTHING trả 0 rows nếu duplicate.
-- Atomic — race giữa 2 request cùng nonce chỉ 1 win.
--
-- Cleanup pg_cron mỗi 15 phút:
--   pg_try_advisory_lock (chống 2 worker cùng lock).
--   SET statement_timeout = '30s' (chống hang).
--   DELETE WHERE expires_at < now() - interval '1 hour' (buffer chống
--   race với transaction đang consume nonce vừa insert).
--
-- RLS/privilege:
--   ENABLE ROW LEVEL SECURITY, default deny.
--   GRANT INSERT/SELECT/DELETE chỉ service_role.
--   REVOKE anon/authenticated.
--
-- KHÔNG chạy migration này lên shared DB trong phiên này.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Bảng
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.warehouse_agent_request_nonces (
  agent_id uuid NOT NULL REFERENCES public.warehouse_agents(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  request_timestamp timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_agent_request_nonces_pk PRIMARY KEY (agent_id, nonce),
  CONSTRAINT warehouse_agent_request_nonces_nonce_length
    CHECK (char_length(nonce) BETWEEN 8 AND 128)
);

COMMENT ON TABLE public.warehouse_agent_request_nonces IS
  'B1.3 HMAC v2 replay protection. Consume pattern: INSERT ON CONFLICT DO NOTHING; '
  'duplicate = replay rejected. Cleanup: pg_cron mỗi 15 phút, buffer 1h sau expires_at.';

COMMENT ON COLUMN public.warehouse_agent_request_nonces.nonce IS
  'Agent-generated nonce. Khuyên UUIDv4 hoặc 32-byte random hex. 8-128 chars.';

COMMENT ON COLUMN public.warehouse_agent_request_nonces.expires_at IS
  'Computed by backend at consume time: request_timestamp + MAX_CLOCK_SKEW + safety_buffer. '
  'Sau expires_at, nonce có thể bị cleanup (không cần chống replay ngoài window).';

-- ----------------------------------------------------------------------------
-- 2. Index cho cleanup
-- ----------------------------------------------------------------------------
-- PK (agent_id, nonce) đủ cho consume lookup.
-- Cleanup query WHERE expires_at < X — cần index riêng.
CREATE INDEX IF NOT EXISTS idx_warehouse_agent_request_nonces_expires_at
  ON public.warehouse_agent_request_nonces (expires_at);

-- ----------------------------------------------------------------------------
-- 3. RLS + privileges
-- ----------------------------------------------------------------------------
ALTER TABLE public.warehouse_agent_request_nonces ENABLE ROW LEVEL SECURITY;
-- Default deny (không thêm policy nào cho authenticated/anon).
-- service_role bypass RLS.

REVOKE ALL ON TABLE public.warehouse_agent_request_nonces FROM PUBLIC;
REVOKE ALL ON TABLE public.warehouse_agent_request_nonces FROM anon;
REVOKE ALL ON TABLE public.warehouse_agent_request_nonces FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.warehouse_agent_request_nonces TO service_role;

-- ----------------------------------------------------------------------------
-- 4. Cleanup function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_expired_agent_nonces()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_deleted int;
  v_lock_acquired boolean;
BEGIN
  -- Advisory lock chống 2 worker cùng chạy (pg_cron overlap hoặc gọi tay).
  -- Key: hashtext('cleanup_expired_agent_nonces') → int.
  SELECT pg_try_advisory_lock(hashtext('cleanup_expired_agent_nonces'))
    INTO v_lock_acquired;
  IF NOT v_lock_acquired THEN
    RAISE NOTICE 'cleanup_expired_agent_nonces: lock busy, skip';
    RETURN 0;
  END IF;

  -- Buffer 1h sau expires_at để chống race với tx consume nonce vừa insert
  -- (expires_at có thể trong quá khứ nếu clock skew).
  DELETE FROM public.warehouse_agent_request_nonces
  WHERE expires_at < now() - interval '1 hour';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM pg_advisory_unlock(hashtext('cleanup_expired_agent_nonces'));

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_agent_nonces() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_expired_agent_nonces() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_expired_agent_nonces() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_agent_nonces() TO service_role;

COMMENT ON FUNCTION public.cleanup_expired_agent_nonces() IS
  'B1.3 nonce cleanup. pg_try_advisory_lock + statement_timeout 30s. '
  'Buffer 1h sau expires_at chống race consume. Chạy qua pg_cron mỗi 15 phút.';

-- ----------------------------------------------------------------------------
-- 5. pg_cron schedule mỗi 15 phút
-- ----------------------------------------------------------------------------
-- Chỉ schedule nếu pg_cron extension có sẵn (V0 dump đã enable — reaper).
-- Nếu env dev/staging chưa enable, migration này sẽ fail — chấp nhận
-- vì mọi env cần pg_cron cho các job khác của Betacom.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Idempotent: unschedule nếu đã tồn tại rồi mới schedule lại.
    PERFORM cron.unschedule('cleanup-agent-nonces')
      FROM cron.job WHERE jobname = 'cleanup-agent-nonces';
    PERFORM cron.schedule(
      'cleanup-agent-nonces',
      '*/15 * * * *',
      $CRON$SELECT public.cleanup_expired_agent_nonces();$CRON$
    );
  ELSE
    RAISE NOTICE 'pg_cron not installed — cleanup will not run automatically. '
      'Enable pg_cron or run cleanup_expired_agent_nonces() from application.';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. Postcondition guard
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'warehouse_agent_request_nonces'
  ) THEN
    RAISE EXCEPTION 'b1_3 postcondition failed: nonce table not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'cleanup_expired_agent_nonces'
  ) THEN
    RAISE EXCEPTION 'b1_3 postcondition failed: cleanup function not created';
  END IF;

  -- Verify RLS enabled + no auth policies (default deny).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'warehouse_agent_request_nonces'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'b1_3 postcondition failed: RLS not enabled on nonce table';
  END IF;

  -- Verify anon/authenticated không có privilege.
  IF has_table_privilege('anon', 'public.warehouse_agent_request_nonces', 'INSERT')
     OR has_table_privilege('authenticated', 'public.warehouse_agent_request_nonces', 'INSERT') THEN
    RAISE EXCEPTION 'b1_3 postcondition failed: anon/authenticated has INSERT on nonce table';
  END IF;
END $$;

COMMIT;
