-- ============================================================================
-- B1.1 verification script — chạy READ-ONLY trên shared DB HOẶC lên
-- Supabase branch có 2 org seed để test destructive.
--
-- KHÔNG apply migration mới ở phần đầu — chỉ verify state hiện tại +
-- test cross-tenant contract của RPC v2 (giả định migration 140100/140200
-- đã apply).
--
-- Chạy tay: paste từng section vào Supabase SQL editor hoặc psql.
-- Section 1-3: READ-ONLY (an toàn shared DB).
-- Section 4-6: DESTRUCTIVE (chỉ chạy trên Supabase branch).
-- ============================================================================

-- ============================================================================
-- SECTION 1 (READ-ONLY): verify migration reconciliation state
-- ============================================================================
-- 1.1: schema_migrations có row cho reconciliation mới?
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version IN ('20260704160000', '20260707140000', '20260707140100', '20260707140200')
ORDER BY version;

-- 1.2: file A effect (5 cột đã drop khỏi organizations)
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'organizations'
  AND column_name IN ('legal_name', 'tax_code', 'phone', 'email', 'address');
-- Kỳ vọng: 0 row.

-- 1.3: file B effect (3 index đã tồn tại)
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_packing_events_org_business_date',
    'idx_packing_events_org_scanned_at',
    'idx_warehouse_scan_raw_events_org_received_at'
  )
ORDER BY indexname;
-- Kỳ vọng: 3 row.

-- ============================================================================
-- SECTION 2 (READ-ONLY): verify RPC CRIT-5 ACL + shape
-- ============================================================================
-- 2.1: apply_camera_probes (v1) — anon/authenticated ĐÃ bị REVOKE
SELECT p.proname,
       a.privilege_type,
       r.rolname AS grantee
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
CROSS JOIN LATERAL aclexplode(p.proacl) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public'
  AND p.proname = 'apply_camera_probes'
  AND r.rolname IN ('anon', 'authenticated');
-- Kỳ vọng: 0 row. Trước migration CRIT-5: 2 row (anon + authenticated).

-- 2.2: apply_camera_probes_v2 tồn tại + đúng signature + đúng grantees
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef,
       array_to_string(p.proconfig, ' ') AS config
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'apply_camera_probes_v2';
-- Kỳ vọng: 1 row, args = 'p_organization_id uuid, p_probes jsonb',
-- prosecdef = true, config chứa 'search_path=public, pg_temp'.

SELECT r.rolname AS grantee
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
CROSS JOIN LATERAL aclexplode(p.proacl) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND p.proname = 'apply_camera_probes_v2'
  AND a.privilege_type = 'EXECUTE'
ORDER BY r.rolname;
-- Kỳ vọng: service_role, postgres (owner). KHÔNG có anon/authenticated.

-- ============================================================================
-- SECTION 3 (READ-ONLY): verify RPC CRIT-6 shape + comment
-- ============================================================================
-- 3.1: enqueue_clip_generation vẫn cùng signature (không tạo overload mới)
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       (SELECT count(*) FROM pg_proc p2
        JOIN pg_namespace n2 ON p2.pronamespace = n2.oid
        WHERE n2.nspname = 'public' AND p2.proname = 'enqueue_clip_generation')
         AS overload_count
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'enqueue_clip_generation';
-- Kỳ vọng: 1 row, overload_count = 1.

-- 3.2: description có chứa 'CRIT-6 verify' (dấu hiệu migration mới đã apply)
SELECT d.description
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass
WHERE n.nspname = 'public' AND p.proname = 'enqueue_clip_generation';
-- Kỳ vọng: description chứa 'CRIT-6' hoặc 'verify packing_event, camera VÀ agent'.

-- ============================================================================
-- SECTION 4 (DESTRUCTIVE, chỉ chạy Supabase branch): seed 2 org test
-- ============================================================================
-- KHÔNG CHẠY trên shared prod DB. Chỉ chạy trên branch có RESET được.

-- BEGIN;
--   INSERT INTO public.organizations(id, name, slug, status)
--   VALUES
--     ('00000000-0000-0000-0000-00000000A000', 'Org A test', 'orgA-test', 'active'),
--     ('00000000-0000-0000-0000-00000000B000', 'Org B test', 'orgB-test', 'active');
--
--   INSERT INTO public.cameras(id, organization_id, name, camera_code, ip, rtsp_port, rtsp_path, username, status)
--   VALUES
--     ('00000000-0000-0000-0000-00000000A001', '00000000-0000-0000-0000-00000000A000', 'Cam A', 'CAM_A', '10.0.0.1', 554, '/stream', 'admin', 'active'),
--     ('00000000-0000-0000-0000-00000000B001', '00000000-0000-0000-0000-00000000B000', 'Cam B', 'CAM_B', '10.0.0.2', 554, '/stream', 'admin', 'active');
--
--   INSERT INTO public.warehouse_agents(id, organization_id, code, name, secret, status)
--   VALUES
--     ('00000000-0000-0000-0000-00000000A100', '00000000-0000-0000-0000-00000000A000', 'AGENT_A', 'Agent A', 'secret_a_dummy_16bytes_ok', 'active'),
--     ('00000000-0000-0000-0000-00000000B100', '00000000-0000-0000-0000-00000000B000', 'AGENT_B', 'Agent B', 'secret_b_dummy_16bytes_ok', 'active');
-- COMMIT;

-- ============================================================================
-- SECTION 5 (DESTRUCTIVE): CRIT-5 test cases (apply_camera_probes_v2)
-- ============================================================================

-- CASE 5.1: Org A + camera A → thành công
-- SET LOCAL role = 'service_role';
-- SELECT public.apply_camera_probes_v2(
--   '00000000-0000-0000-0000-00000000A000'::uuid,
--   '[{"id":"00000000-0000-0000-0000-00000000A001","last_probe_ok":true,"last_probe_latency_ms":50,"probe_consecutive_fails":0}]'::jsonb
-- );
-- Kỳ vọng: {"requested":1,"updated":1,"rejected":0}

-- CASE 5.2: Org A khai camera B (cross-tenant) → rejected count = 1
-- SELECT public.apply_camera_probes_v2(
--   '00000000-0000-0000-0000-00000000A000'::uuid,
--   '[{"id":"00000000-0000-0000-0000-00000000B001","last_probe_ok":true,"last_probe_latency_ms":50,"probe_consecutive_fails":0}]'::jsonb
-- );
-- Kỳ vọng: {"requested":1,"updated":0,"rejected":1}
-- Verify camera B chưa bị update:
-- SELECT last_probe_ok, last_probe_latency_ms FROM public.cameras WHERE id = '00000000-0000-0000-0000-00000000B001';
-- Kỳ vọng: NULL / NULL (từ seed) — không thay đổi.

-- CASE 5.3: payload trộn A+B, Org A → chỉ A update
-- SELECT public.apply_camera_probes_v2(
--   '00000000-0000-0000-0000-00000000A000'::uuid,
--   '[
--     {"id":"00000000-0000-0000-0000-00000000A001","last_probe_ok":false,"last_probe_latency_ms":null,"probe_consecutive_fails":2},
--     {"id":"00000000-0000-0000-0000-00000000B001","last_probe_ok":false,"last_probe_latency_ms":null,"probe_consecutive_fails":2}
--   ]'::jsonb
-- );
-- Kỳ vọng: {"requested":2,"updated":1,"rejected":1}

-- CASE 5.4: camera không tồn tại → rejected
-- SELECT public.apply_camera_probes_v2(
--   '00000000-0000-0000-0000-00000000A000'::uuid,
--   '[{"id":"00000000-0000-0000-0000-000000000FFF","last_probe_ok":true,"last_probe_latency_ms":50,"probe_consecutive_fails":0}]'::jsonb
-- );
-- Kỳ vọng: {"requested":1,"updated":0,"rejected":1}

-- CASE 5.5: payload rỗng → trả 0 count
-- SELECT public.apply_camera_probes_v2(
--   '00000000-0000-0000-0000-00000000A000'::uuid,
--   '[]'::jsonb
-- );
-- Kỳ vọng: {"requested":0,"updated":0,"rejected":0}

-- CASE 5.6: p_organization_id NULL → raise
-- SELECT public.apply_camera_probes_v2(
--   NULL,
--   '[{"id":"00000000-0000-0000-0000-00000000A001","last_probe_ok":true,"last_probe_latency_ms":50,"probe_consecutive_fails":0}]'::jsonb
-- );
-- Kỳ vọng: RAISE 'p_organization_id required'.

-- CASE 5.7: too many probes (> 100) → raise
-- (skip: tự sinh 101 item khi test)

-- ============================================================================
-- SECTION 6 (DESTRUCTIVE): CRIT-6 test cases (enqueue_clip_generation)
-- ============================================================================
-- Cần seed packing_events cho Org A + Org B trước:
-- INSERT INTO public.packing_events(id, organization_id, warehouse_id, waybill_code, ...) VALUES ...;

-- CASE 6.1: event A + camera A + agent A → OK
-- SELECT * FROM public.enqueue_clip_generation(
--   '00000000-0000-0000-0000-00000000A000'::uuid,
--   '<pe_id_A>'::uuid,
--   '00000000-0000-0000-0000-00000000A001'::uuid,
--   'TEST_WB_A',
--   '00000000-0000-0000-0000-00000000A100'::uuid,
--   now() - interval '10 minutes',
--   now(),
--   false,
--   '[]'::jsonb,
--   '{}'::jsonb,
--   '{}'::jsonb
-- );
-- Kỳ vọng: 1 row với result_status = 'created' hoặc 'reused_existing_pending'.

-- CASE 6.2: event A + camera B (cross-tenant camera) → raise enqueue_camera_not_in_org
-- SELECT * FROM public.enqueue_clip_generation(
--   '00000000-0000-0000-0000-00000000A000'::uuid,
--   '<pe_id_A>'::uuid,
--   '00000000-0000-0000-0000-00000000B001'::uuid,  -- camera B
--   'TEST_WB_A',
--   '00000000-0000-0000-0000-00000000A100'::uuid,
--   now(), now(), false, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb
-- );
-- Kỳ vọng: RAISE 'enqueue_camera_not_in_org'.

-- CASE 6.3: event A + agent B (cross-tenant agent) → raise enqueue_agent_not_in_org
-- SELECT * FROM public.enqueue_clip_generation(
--   '00000000-0000-0000-0000-00000000A000'::uuid,
--   '<pe_id_A>'::uuid,
--   '00000000-0000-0000-0000-00000000A001'::uuid,
--   'TEST_WB_A',
--   '00000000-0000-0000-0000-00000000B100'::uuid,  -- agent B
--   now(), now(), false, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb
-- );
-- Kỳ vọng: RAISE 'enqueue_agent_not_in_org'.

-- CASE 6.4: event B + camera A (event cross-tenant vs caller org) → raise enqueue_pe_not_in_org
-- SELECT * FROM public.enqueue_clip_generation(
--   '00000000-0000-0000-0000-00000000A000'::uuid,  -- caller Org A
--   '<pe_id_B>'::uuid,                              -- event B
--   '00000000-0000-0000-0000-00000000A001'::uuid,
--   'TEST_WB', '00000000-0000-0000-0000-00000000A100'::uuid,
--   now(), now(), false, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb
-- );
-- Kỳ vọng: RAISE 'enqueue_pe_not_in_org'.

-- CASE 6.5: 2 enqueue đồng thời cho cùng pe_id (Org A + camera A + agent A)
-- Chạy 2 tx concurrent bằng psql 2 session:
--   Session 1: BEGIN; SELECT enqueue_clip_generation(...); (chưa COMMIT)
--   Session 2: SELECT enqueue_clip_generation(...) cùng args;
--   Session 1: COMMIT;
--   Session 2: xem kết quả — 'reused_existing_pending' hoặc block trên
--   unique index uniq_order_proof_clip_pending_per_event.
-- Kỳ vọng: 1 row 'created', 1 row 'reused_existing_pending'.

-- CASE 6.6: retry cùng event → reused pending
-- (Chạy 2 lần liên tiếp cùng args; lần 2 phải trả 'reused_existing_pending')

-- ============================================================================
-- CLEANUP (chỉ trên branch):
-- ============================================================================
-- BEGIN;
--   DELETE FROM public.order_proof_clips WHERE organization_id IN
--     ('00000000-0000-0000-0000-00000000A000', '00000000-0000-0000-0000-00000000B000');
--   DELETE FROM public.agent_commands WHERE organization_id IN
--     ('00000000-0000-0000-0000-00000000A000', '00000000-0000-0000-0000-00000000B000');
--   DELETE FROM public.packing_events WHERE organization_id IN
--     ('00000000-0000-0000-0000-00000000A000', '00000000-0000-0000-0000-00000000B000');
--   DELETE FROM public.cameras WHERE id IN
--     ('00000000-0000-0000-0000-00000000A001', '00000000-0000-0000-0000-00000000B001');
--   DELETE FROM public.warehouse_agents WHERE id IN
--     ('00000000-0000-0000-0000-00000000A100', '00000000-0000-0000-0000-00000000B100');
--   DELETE FROM public.organizations WHERE id IN
--     ('00000000-0000-0000-0000-00000000A000', '00000000-0000-0000-0000-00000000B000');
-- COMMIT;
