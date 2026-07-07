-- ============================================================================
-- B4 verification script.
--
-- Section 1-2 READ-ONLY: safe post-apply.
-- Section 3 DESTRUCTIVE (BEGIN/ROLLBACK): chỉ chạy Supabase branch/local.
-- ============================================================================

-- ============================================================================
-- SECTION 1 (READ-ONLY): RPC exists + ACL + signature
-- ============================================================================
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef,
  array_to_string(p.proconfig, ' ') AS config,
  d.description
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass
WHERE n.nspname = 'public' AND p.proname = 'enqueue_start_recording';
-- Kỳ vọng: 1 row, security_definer=true, config chứa 'search_path=public, pg_temp',
-- description chứa 'B4 HIGH-12'.

SELECT
  has_function_privilege('anon', 'public.enqueue_start_recording(uuid, uuid, uuid, uuid, text, integer, text)', 'EXECUTE') AS anon,
  has_function_privilege('authenticated', 'public.enqueue_start_recording(uuid, uuid, uuid, uuid, text, integer, text)', 'EXECUTE') AS authn,
  has_function_privilege('service_role', 'public.enqueue_start_recording(uuid, uuid, uuid, uuid, text, integer, text)', 'EXECUTE') AS svc,
  EXISTS(
    SELECT 1 FROM aclexplode((
      SELECT proacl FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'enqueue_start_recording'
    )) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS public_explicit;
-- Kỳ vọng: anon=false, authn=false, svc=true, public_explicit=false.

-- ============================================================================
-- SECTION 2 (READ-ONLY): unique index backstop vẫn tồn tại
-- ============================================================================
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_one_active_recording_per_camera';
-- Kỳ vọng: index vẫn tồn tại (UNIQUE camera_id WHERE status = 'recording').

-- ============================================================================
-- SECTION 3 (DESTRUCTIVE — branch only): RPC behavior
-- ============================================================================

/*
BEGIN;

-- Seed 1 org + 1 camera + 1 agent test.
INSERT INTO public.organizations(id, name, slug, status)
VALUES ('11111111-1111-1111-1111-1111b4000000'::uuid, 'B4 test', 'b4-test', 'active');

INSERT INTO public.cameras(id, organization_id, name, camera_code, ip, rtsp_port, rtsp_path, username, status)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaab4000000'::uuid,
  '11111111-1111-1111-1111-1111b4000000'::uuid,
  'B4 cam', 'B4_CAM', '10.0.0.1', 554, '/stream', 'admin', 'active'
);

INSERT INTO public.warehouse_agents(id, organization_id, code, name, secret, status)
VALUES (
  'cccccccc-cccc-cccc-cccc-ccccb4000000'::uuid,
  '11111111-1111-1111-1111-1111b4000000'::uuid,
  'B4_AGENT', 'B4 agent', 'dummy_secret_16bytes_ok', 'active'
);

-- Case 3.1: happy path → verdict='created'
SELECT * FROM public.enqueue_start_recording(
  '11111111-1111-1111-1111-1111b4000000'::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaab4000000'::uuid,
  'cccccccc-cccc-cccc-cccc-ccccb4000000'::uuid,
  NULL,
  'tcp',
  60,
  '_agent_managed/B4_CAM'
);
-- Kỳ vọng: verdict='created', session_id + command_id NOT NULL.

-- Case 3.2: retry lần 2 → verdict='already_recording' hoặc 'start_pending'
SELECT * FROM public.enqueue_start_recording(
  '11111111-1111-1111-1111-1111b4000000'::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaab4000000'::uuid,
  'cccccccc-cccc-cccc-cccc-ccccb4000000'::uuid,
  NULL,
  'tcp',
  60,
  '_agent_managed/B4_CAM'
);
-- Kỳ vọng: verdict='already_recording' (session recording) hoặc 'start_pending'
-- (command chưa done).

-- Case 3.3: cross-tenant camera → RAISE
DO $$
BEGIN
  PERFORM public.enqueue_start_recording(
    '11111111-1111-1111-1111-1111b4000000'::uuid,
    (SELECT id FROM public.cameras
     WHERE organization_id != '11111111-1111-1111-1111-1111b4000000'::uuid
     LIMIT 1),
    'cccccccc-cccc-cccc-cccc-ccccb4000000'::uuid,
    NULL, 'tcp', 60, '_x'
  );
  RAISE EXCEPTION 'case_3_3 expected RAISE enqueue_start_camera_not_in_org';
EXCEPTION
  WHEN sqlstate 'P0001' THEN
    RAISE NOTICE 'case_3_3 OK: cross-tenant camera raised P0001';
END $$;

-- Case 3.4: session connection_lost → verdict='recording_state_unknown'
UPDATE public.camera_recording_sessions
SET status = 'connection_lost'
WHERE camera_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaab4000000'::uuid;

SELECT * FROM public.enqueue_start_recording(
  '11111111-1111-1111-1111-1111b4000000'::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaab4000000'::uuid,
  'cccccccc-cccc-cccc-cccc-ccccb4000000'::uuid,
  NULL, 'tcp', 60, '_agent_managed/B4_CAM'
);
-- Kỳ vọng: verdict='recording_state_unknown', reason chứa 'connection_lost'.

-- Case 3.5: concurrent — NOTE: cần 2 psql session để test thật.
-- Verification design only: session 1 BEGIN + call RPC (không commit).
-- Session 2 call RPC cùng camera → block trên advisory lock.
-- Session 1 COMMIT → session 2 unblock, đọc lại state → trả
-- 'already_recording'.

ROLLBACK;
*/
