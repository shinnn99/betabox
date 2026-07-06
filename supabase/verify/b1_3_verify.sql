-- ============================================================================
-- B1.3 verification script.
--
-- Section 1-4 READ-ONLY: an toàn shared DB sau khi migration 20260707180000 apply.
-- Section 5-6 DESTRUCTIVE: BỌC BEGIN/ROLLBACK, chỉ chạy Supabase branch/local.
-- ============================================================================

-- ============================================================================
-- SECTION 1 (READ-ONLY): schema nonce table + PK/index/constraint
-- ============================================================================
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'warehouse_agent_request_nonces'
ORDER BY ordinal_position;
-- Kỳ vọng: 5 cột (agent_id, nonce, request_timestamp, expires_at, created_at).

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'warehouse_agent_request_nonces';
-- Kỳ vọng: PK (agent_id, nonce) + idx_...expires_at.

SELECT con.conname, con.contype,
  pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class cl ON con.conrelid = cl.oid
JOIN pg_namespace ns ON cl.relnamespace = ns.oid
WHERE ns.nspname = 'public' AND cl.relname = 'warehouse_agent_request_nonces'
ORDER BY con.contype, con.conname;
-- Kỳ vọng: PK, FK agent_id → warehouse_agents ON DELETE CASCADE, CHECK nonce length.

-- ============================================================================
-- SECTION 2 (READ-ONLY): RLS + privileges
-- ============================================================================
SELECT
  cl.relname,
  cl.relrowsecurity AS rls_enabled,
  count(pol.polname) AS policy_count
FROM pg_class cl
JOIN pg_namespace ns ON cl.relnamespace = ns.oid
LEFT JOIN pg_policy pol ON pol.polrelid = cl.oid
WHERE ns.nspname = 'public' AND cl.relname = 'warehouse_agent_request_nonces'
GROUP BY cl.relname, cl.relrowsecurity;
-- Kỳ vọng: rls_enabled = true, policy_count = 0 (default deny).

SELECT
  grantee,
  privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name = 'warehouse_agent_request_nonces'
  AND grantee IN ('anon', 'authenticated', 'service_role', 'postgres', 'PUBLIC')
ORDER BY grantee, privilege_type;
-- Kỳ vọng: chỉ service_role có SELECT/INSERT/DELETE; anon/authenticated/PUBLIC KHÔNG có.

-- ============================================================================
-- SECTION 3 (READ-ONLY): cleanup function + pg_cron schedule
-- ============================================================================
SELECT
  p.proname,
  p.prosecdef AS security_definer,
  array_to_string(p.proconfig, ' ') AS config
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'cleanup_expired_agent_nonces';
-- Kỳ vọng: 1 row, security_definer=true, config chứa search_path + statement_timeout=30s.

SELECT jobname, schedule, command
FROM cron.job
WHERE jobname = 'cleanup-agent-nonces';
-- Kỳ vọng: 1 row, schedule = '*/15 * * * *'.

-- ============================================================================
-- SECTION 4 (READ-ONLY): counter row hiện tại
-- ============================================================================
SELECT
  count(*) AS total_nonces,
  count(*) FILTER (WHERE expires_at < now()) AS expired_pending_cleanup
FROM public.warehouse_agent_request_nonces;
-- Kỳ vọng ngay sau migration: 0 rows.

-- ============================================================================
-- SECTION 5 (DESTRUCTIVE — Supabase branch/local): concurrent replay test
-- ============================================================================

/*
BEGIN;

-- Seed 1 agent test (yêu cầu org tồn tại).
INSERT INTO public.warehouse_agents(id, organization_id, code, name, secret, status)
VALUES (
  '11111111-1111-1111-1111-1111b1_3a01'::uuid,
  (SELECT id FROM public.organizations LIMIT 1),
  'B1_3_AGENT_TEST',
  'B1.3 test agent',
  'dummy_secret_16bytes_ok',
  'active'
);

-- Case 5.1: INSERT nonce lần 1 → success.
INSERT INTO public.warehouse_agent_request_nonces(agent_id, nonce, request_timestamp, expires_at)
VALUES (
  '11111111-1111-1111-1111-1111b1_3a01'::uuid,
  'nonce_test_first_time',
  now(),
  now() + interval '6 minutes'
)
ON CONFLICT (agent_id, nonce) DO NOTHING
RETURNING agent_id, nonce;
-- Kỳ vọng: 1 row returned.

-- Case 5.2: INSERT cùng nonce lần 2 → duplicate → ON CONFLICT DO NOTHING trả 0 row.
INSERT INTO public.warehouse_agent_request_nonces(agent_id, nonce, request_timestamp, expires_at)
VALUES (
  '11111111-1111-1111-1111-1111b1_3a01'::uuid,
  'nonce_test_first_time',
  now(),
  now() + interval '6 minutes'
)
ON CONFLICT (agent_id, nonce) DO NOTHING
RETURNING agent_id, nonce;
-- Kỳ vọng: 0 row returned → replay rejected.

-- Case 5.3: nonce khác cùng agent → OK.
INSERT INTO public.warehouse_agent_request_nonces(agent_id, nonce, request_timestamp, expires_at)
VALUES (
  '11111111-1111-1111-1111-1111b1_3a01'::uuid,
  'nonce_test_second',
  now(),
  now() + interval '6 minutes'
)
ON CONFLICT (agent_id, nonce) DO NOTHING
RETURNING agent_id, nonce;
-- Kỳ vọng: 1 row.

-- Case 5.4: CHECK nonce length → nonce quá ngắn reject.
INSERT INTO public.warehouse_agent_request_nonces(agent_id, nonce, request_timestamp, expires_at)
VALUES (
  '11111111-1111-1111-1111-1111b1_3a01'::uuid,
  'short',
  now(),
  now() + interval '6 minutes'
);
-- Kỳ vọng: RAISE constraint violation "check violation warehouse_agent_request_nonces_nonce_length".

ROLLBACK;
*/

-- ============================================================================
-- SECTION 6 (DESTRUCTIVE): cleanup function behavior
-- ============================================================================

/*
BEGIN;

-- Seed expired nonce.
INSERT INTO public.warehouse_agents(id, organization_id, code, name, secret, status)
VALUES (
  '11111111-1111-1111-1111-1111b1_3a02'::uuid,
  (SELECT id FROM public.organizations LIMIT 1),
  'B1_3_AGENT_CLEANUP',
  'B1.3 cleanup test',
  'dummy_secret_16bytes_ok',
  'active'
);

INSERT INTO public.warehouse_agent_request_nonces(agent_id, nonce, request_timestamp, expires_at)
VALUES
  ('11111111-1111-1111-1111-1111b1_3a02', 'nonce_old_expired',
    now() - interval '2 hours', now() - interval '90 minutes'),
  ('11111111-1111-1111-1111-1111b1_3a02', 'nonce_recent_expired',
    now() - interval '10 minutes', now() - interval '5 minutes'),
  ('11111111-1111-1111-1111-1111b1_3a02', 'nonce_future',
    now(), now() + interval '6 minutes');

-- Cleanup chỉ xóa những nonce expires_at < now() - 1h (buffer).
SELECT public.cleanup_expired_agent_nonces() AS deleted_count;
-- Kỳ vọng: 1 (chỉ nonce_old_expired).

SELECT nonce FROM public.warehouse_agent_request_nonces
WHERE agent_id = '11111111-1111-1111-1111-1111b1_3a02'::uuid;
-- Kỳ vọng: 2 rows (nonce_recent_expired + nonce_future).

ROLLBACK;
*/
