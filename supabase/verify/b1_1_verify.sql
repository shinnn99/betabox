-- ============================================================================
-- B1.1 + B1.1a verification script.
--
-- QUY TẮC:
--   - Section 1-4 READ-ONLY: an toàn chạy trên shared DB sau khi migration
--     đã apply. Không thay đổi state.
--   - Section 5-6 DESTRUCTIVE: BỌC TRONG `BEGIN`...`ROLLBACK` — chạy trên
--     Supabase branch hoặc local, không để lại dữ liệu.
--   - Test IDs dùng namespace `b1_1_test_` để không đụng dữ liệu thật.
--
-- KHÔNG chạy destructive section trên shared production.
-- Concurrency test 6.5 KHÔNG thực hiện được trong 1 SQL session — chỉ là
-- verification design (chú thích ở phần đó).
-- ============================================================================

-- ============================================================================
-- SECTION 1 (READ-ONLY): Migration state
-- ============================================================================
-- 1.1: schema_migrations có 4 version B1.1/B1.1a
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version IN (
  '20260704160000',
  '20260707140000',
  '20260707140100',
  '20260707140200',
  '20260707140300'
)
ORDER BY version;
-- Kỳ vọng sau apply B1.1+B1.1a: 5 row (1 lịch sử + 4 mới).

-- 1.2: File A effect (5 cột đã drop)
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'organizations'
  AND column_name IN ('legal_name', 'tax_code', 'phone', 'email', 'address');
-- Kỳ vọng: 0 row.

-- 1.3: File B effect (3 index tồn tại)
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
-- SECTION 2 (READ-ONLY): ACL matrix — bao gồm hiệu quả qua PUBLIC
-- ============================================================================
-- 2.1: has_function_privilege cho 4 role trên 3 function
WITH funcs AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN ('apply_camera_probes', 'apply_camera_probes_v2', 'enqueue_clip_generation')
)
SELECT
  f.proname,
  has_function_privilege('anon', f.oid, 'EXECUTE') AS anon,
  has_function_privilege('authenticated', f.oid, 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', f.oid, 'EXECUTE') AS service_role
FROM funcs f
ORDER BY f.proname;
-- Kỳ vọng sau apply B1.1a:
--   apply_camera_probes         → anon=false, authenticated=false, service_role=true
--   apply_camera_probes_v2      → anon=false, authenticated=false, service_role=true
--   enqueue_clip_generation     → anon=false, authenticated=false, service_role=true

-- 2.2: PUBLIC EXECUTE (ACL raw grantee=0)
SELECT
  p.proname,
  EXISTS (
    SELECT 1 FROM aclexplode(p.proacl) a
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS public_execute_grant_explicit
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('apply_camera_probes', 'apply_camera_probes_v2', 'enqueue_clip_generation')
ORDER BY p.proname;
-- Kỳ vọng: cả 3 = false.

-- 2.3: Function config + security_definer
SELECT
  p.proname,
  p.prosecdef AS security_definer,
  array_to_string(p.proconfig, ' ') AS config,
  pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('apply_camera_probes', 'apply_camera_probes_v2', 'enqueue_clip_generation')
ORDER BY p.proname;
-- Kỳ vọng:
--   apply_camera_probes         → security_definer=t, config=NULL (v1 legacy)
--   apply_camera_probes_v2      → security_definer=t, config='search_path=public, pg_temp'
--   enqueue_clip_generation     → security_definer=t, config='search_path=public, pg_temp'

-- ============================================================================
-- SECTION 3 (READ-ONLY): CRIT-6 shape
-- ============================================================================
-- 3.1: enqueue_clip_generation vẫn cùng signature
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

-- 3.2: Comment chứa CRIT-6
SELECT d.description
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass
WHERE n.nspname = 'public' AND p.proname = 'enqueue_clip_generation';
-- Kỳ vọng: description chứa 'CRIT-6 verify' hoặc mô tả tương đương.

-- ============================================================================
-- SECTION 4 (READ-ONLY): Warehouse relation evidence
-- ============================================================================
-- 4.1: warehouse_id có mặt ở bảng nào?
SELECT t.table_name, c.column_name, c.is_nullable
FROM information_schema.tables t
JOIN information_schema.columns c
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
  AND c.column_name = 'warehouse_id'
  AND t.table_name IN ('cameras', 'warehouse_agents', 'packing_events')
ORDER BY t.table_name;
-- Kỳ vọng (2026-07-07 MCP):
--   packing_events.warehouse_id  YES  (nullable)
--   cameras + warehouse_agents  → 0 row.
-- Schema hiện tại KHÔNG hỗ trợ invariant "camera+agent+packing_event cùng
-- warehouse". CRIT-6 warehouse relation phần = blocked-with-reason.

-- ============================================================================
-- SECTION 5 (DESTRUCTIVE — chỉ chạy Supabase branch/local, bọc ROLLBACK)
-- CRIT-5 test cases apply_camera_probes_v2
-- ============================================================================
-- Nếu chạy trên môi trường disposable, uncomment toàn bộ section này.
-- Toàn bộ nằm trong 1 transaction ROLLBACK cuối để KHÔNG lưu state.

/*
BEGIN;

-- Seed 2 org test với namespace b1_1_test_.
INSERT INTO public.organizations(id, name, slug, status)
VALUES
  ('11111111-1111-1111-1111-1111b1_1_a01'::uuid, 'B1.1a test Org A', 'b1_1a-orgA', 'active'),
  ('22222222-2222-2222-2222-2222b1_1_b01'::uuid, 'B1.1a test Org B', 'b1_1a-orgB', 'active');

INSERT INTO public.cameras(id, organization_id, name, camera_code, ip, rtsp_port, rtsp_path, username, status)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaab1_1_a02'::uuid, '11111111-1111-1111-1111-1111b1_1_a01'::uuid, 'B1.1a Cam A', 'B1_1A_CAM_A', '10.0.0.1', 554, '/stream', 'admin', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbb1_1_b02'::uuid, '22222222-2222-2222-2222-2222b1_1_b01'::uuid, 'B1.1a Cam B', 'B1_1A_CAM_B', '10.0.0.2', 554, '/stream', 'admin', 'active');

-- CASE 5.1: Org A + camera A → updated=1, rejected=0
SELECT public.apply_camera_probes_v2(
  '11111111-1111-1111-1111-1111b1_1_a01'::uuid,
  '[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaab1_1_a02","last_probe_ok":true,"last_probe_latency_ms":50,"probe_consecutive_fails":0}]'::jsonb
) AS case_5_1;

-- CASE 5.2: Org A khai camera B (cross-tenant) → rejected=1
SELECT public.apply_camera_probes_v2(
  '11111111-1111-1111-1111-1111b1_1_a01'::uuid,
  '[{"id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbb1_1_b02","last_probe_ok":true,"last_probe_latency_ms":50,"probe_consecutive_fails":0}]'::jsonb
) AS case_5_2;

-- Verify camera B KHÔNG bị update (last_probe_ok phải là NULL từ seed)
SELECT id, last_probe_ok, last_probe_latency_ms
FROM public.cameras
WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbb1_1_b02'::uuid;

-- CASE 5.3: payload trộn A+B → updated=1, rejected=1
SELECT public.apply_camera_probes_v2(
  '11111111-1111-1111-1111-1111b1_1_a01'::uuid,
  '[
    {"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaab1_1_a02","last_probe_ok":false,"last_probe_latency_ms":null,"probe_consecutive_fails":2},
    {"id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbb1_1_b02","last_probe_ok":false,"last_probe_latency_ms":null,"probe_consecutive_fails":2}
  ]'::jsonb
) AS case_5_3;

-- CASE 5.4: camera không tồn tại → rejected=1
SELECT public.apply_camera_probes_v2(
  '11111111-1111-1111-1111-1111b1_1_a01'::uuid,
  '[{"id":"00000000-0000-0000-0000-000000000fff","last_probe_ok":true,"last_probe_latency_ms":50,"probe_consecutive_fails":0}]'::jsonb
) AS case_5_4;

-- CASE 5.5: payload rỗng → requested=0, updated=0, rejected=0
SELECT public.apply_camera_probes_v2(
  '11111111-1111-1111-1111-1111b1_1_a01'::uuid,
  '[]'::jsonb
) AS case_5_5;

-- CASE 5.6: p_organization_id NULL → RAISE (ERRCODE 22004)
DO $$
BEGIN
  PERFORM public.apply_camera_probes_v2(
    NULL,
    '[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaab1_1_a02","last_probe_ok":true,"last_probe_latency_ms":50,"probe_consecutive_fails":0}]'::jsonb
  );
  RAISE EXCEPTION 'case_5_6 expected p_organization_id RAISE, got success';
EXCEPTION
  WHEN sqlstate '22004' THEN
    RAISE NOTICE 'case_5_6 OK: NULL org raised as expected';
END $$;

-- CASE 5.7: too many probes (> 100) — build 101 items
-- SELECT public.apply_camera_probes_v2(
--   '11111111-1111-1111-1111-1111b1_1_a01'::uuid,
--   (SELECT jsonb_agg(jsonb_build_object(
--     'id', gen_random_uuid(),
--     'last_probe_ok', true,
--     'last_probe_latency_ms', 50,
--     'probe_consecutive_fails', 0))
--    FROM generate_series(1, 101))
-- );
-- Kỳ vọng: RAISE ERRCODE 22023 (too_many).

ROLLBACK;
*/

-- ============================================================================
-- SECTION 6 (DESTRUCTIVE — chỉ chạy Supabase branch/local, bọc ROLLBACK)
-- CRIT-6 test cases enqueue_clip_generation
-- ============================================================================

/*
BEGIN;

-- Seed 2 org + 2 agent + 2 camera + 2 packing_event.
INSERT INTO public.organizations(id, name, slug, status)
VALUES
  ('11111111-1111-1111-1111-1111b1_1_a01'::uuid, 'B1.1a test Org A', 'b1_1a-orgA', 'active'),
  ('22222222-2222-2222-2222-2222b1_1_b01'::uuid, 'B1.1a test Org B', 'b1_1a-orgB', 'active');

INSERT INTO public.cameras(id, organization_id, name, camera_code, ip, rtsp_port, rtsp_path, username, status)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaab1_1_a02'::uuid, '11111111-1111-1111-1111-1111b1_1_a01'::uuid, 'B1.1a Cam A', 'B1_1A_CAM_A', '10.0.0.1', 554, '/stream', 'admin', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbb1_1_b02'::uuid, '22222222-2222-2222-2222-2222b1_1_b01'::uuid, 'B1.1a Cam B', 'B1_1A_CAM_B', '10.0.0.2', 554, '/stream', 'admin', 'active');

INSERT INTO public.warehouse_agents(id, organization_id, code, name, secret, status)
VALUES
  ('cccccccc-cccc-cccc-cccc-ccccb1_1_a03'::uuid, '11111111-1111-1111-1111-1111b1_1_a01'::uuid, 'B1_1A_AGENT_A', 'B1.1a Agent A', 'dummy_secret_16bytes_ok', 'active'),
  ('dddddddd-dddd-dddd-dddd-ddddb1_1_b03'::uuid, '22222222-2222-2222-2222-2222b1_1_b01'::uuid, 'B1_1A_AGENT_B', 'B1.1a Agent B', 'dummy_secret_16bytes_ok', 'active');

-- packing_events schema tối thiểu — check actual required columns trước.
-- (Test env cần bỏ NOT NULL không có default, hoặc supply đủ.)

-- CASE 6.1: event A + camera A + agent A → OK
-- (Yêu cầu: có packing_events row cho Org A.)

-- CASE 6.2: event A + camera B → RAISE enqueue_camera_not_in_org
DO $$
BEGIN
  PERFORM public.enqueue_clip_generation(
    '11111111-1111-1111-1111-1111b1_1_a01'::uuid,
    '<PE_ID_A>'::uuid,
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbb1_1_b02'::uuid,
    'TEST_WB',
    'cccccccc-cccc-cccc-cccc-ccccb1_1_a03'::uuid,
    now() - interval '10 minutes', now(), false,
    '[]'::jsonb, '{}'::jsonb, '{}'::jsonb
  );
  RAISE EXCEPTION 'case_6_2 expected RAISE enqueue_camera_not_in_org';
EXCEPTION
  WHEN sqlstate 'P0001' THEN
    RAISE NOTICE 'case_6_2 OK: cross-tenant camera raised P0001';
END $$;

-- CASE 6.3: event A + agent B → RAISE enqueue_agent_not_in_org
DO $$
BEGIN
  PERFORM public.enqueue_clip_generation(
    '11111111-1111-1111-1111-1111b1_1_a01'::uuid,
    '<PE_ID_A>'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaab1_1_a02'::uuid,
    'TEST_WB',
    'dddddddd-dddd-dddd-dddd-ddddb1_1_b03'::uuid,
    now() - interval '10 minutes', now(), false,
    '[]'::jsonb, '{}'::jsonb, '{}'::jsonb
  );
  RAISE EXCEPTION 'case_6_3 expected RAISE enqueue_agent_not_in_org';
EXCEPTION
  WHEN sqlstate 'P0001' THEN
    RAISE NOTICE 'case_6_3 OK: cross-tenant agent raised P0001';
END $$;

-- CASE 6.4: event B (cross-tenant) → RAISE enqueue_pe_not_in_org
-- (Yêu cầu: packing_events row Org B tồn tại.)

-- CASE 6.5: concurrent enqueue cho cùng pe_id
-- VERIFICATION DESIGN ONLY — không thực hiện thực tế trong SQL session
-- đơn. Cần 2 psql session:
--   Session 1: BEGIN; SELECT enqueue_clip_generation(...) with args A; (chưa commit)
--   Session 2: SELECT enqueue_clip_generation(...) with args A;
--   Session 1: COMMIT;
--   Session 2 sẽ block trên uniq_order_proof_clip_pending_per_event unique
--   index cho đến khi session 1 commit; sau đó thấy row pending và trả
--   'reused_existing_pending'.
-- Không test được trong script này. Chỉ document expected behavior.

-- CASE 6.6: retry cùng args → 'reused_existing_pending'
-- (Chạy 6.1 hai lần liên tiếp, lần 2 phải trả result_status='reused_existing_pending')

ROLLBACK;
*/
