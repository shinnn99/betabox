-- ============================================================================
-- B1.2 verification script.
--
-- QUY TẮC:
--   - Section 1-3 READ-ONLY: an toàn chạy trên shared DB SAU khi migration
--     20260707160000 đã apply.
--   - Section 4-5 DESTRUCTIVE: BỌC TRONG `BEGIN;`...`ROLLBACK;` — chỉ chạy
--     trên Supabase branch hoặc local, không để lại dữ liệu.
--   - Test IDs dùng namespace `b1_2_test_` để không đụng dữ liệu thật.
--
-- KHÔNG chạy destructive section trên shared production.
-- ============================================================================

-- ============================================================================
-- SECTION 1 (READ-ONLY): FK delete rules đã áp đúng
-- ============================================================================
SELECT
  con.conname,
  cl.relname AS from_table,
  att.attname AS from_column,
  cl2.relname AS to_table,
  att2.attname AS to_column,
  CASE con.confdeltype
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END AS delete_rule
FROM pg_constraint con
JOIN pg_class cl ON con.conrelid = cl.oid
JOIN pg_namespace ns ON cl.relnamespace = ns.oid
LEFT JOIN pg_class cl2 ON con.confrelid = cl2.oid
LEFT JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
LEFT JOIN pg_attribute att2 ON att2.attrelid = con.confrelid AND att2.attnum = ANY(con.confkey)
WHERE con.contype = 'f'
  AND ns.nspname = 'public'
  AND cl.relname IN ('platform_audit_log', 'platform_admins', 'audit_logs')
ORDER BY cl.relname, att.attname;
-- Kỳ vọng sau apply:
--   audit_logs_actor_user_id_fkey            → SET NULL (giữ, đã đúng)
--   audit_logs_organization_id_fkey          → SET NULL (đổi từ CASCADE)
--   platform_admins_created_by_fkey          → SET NULL (đổi từ NO ACTION)
--   platform_admins_id_fkey                  → CASCADE (giữ, design đúng)
--   platform_audit_log_actor_user_id_fkey    → SET NULL (đổi từ NO ACTION)
--   platform_audit_log_impersonating_org_id_fkey → SET NULL (đổi từ NO ACTION)

-- ============================================================================
-- SECTION 2 (READ-ONLY): NOT NULL đã drop cho actor_user_id + organization_id
-- ============================================================================
SELECT table_name, column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'platform_audit_log' AND column_name = 'actor_user_id')
    OR (table_name = 'audit_logs' AND column_name = 'organization_id')
  );
-- Kỳ vọng: cả 2 → is_nullable = 'YES'.

-- ============================================================================
-- SECTION 3 (READ-ONLY): Snapshot columns tồn tại + comment
-- ============================================================================
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.is_nullable,
  pgd.description
FROM information_schema.columns c
LEFT JOIN pg_catalog.pg_statio_all_tables st
  ON st.schemaname = c.table_schema AND st.relname = c.table_name
LEFT JOIN pg_catalog.pg_description pgd
  ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
WHERE c.table_schema = 'public'
  AND c.column_name IN (
    'actor_email_snapshot',
    'actor_role_snapshot',
    'target_organization_name_snapshot',
    'organization_id_snapshot',
    'organization_name_snapshot'
  )
ORDER BY c.table_name, c.column_name;
-- Kỳ vọng: 5 row (3 platform_audit_log + 2 audit_logs), tất cả nullable YES,
-- description có "B1.2 immutable snapshot".

-- ============================================================================
-- SECTION 4 (DESTRUCTIVE — chỉ chạy Supabase branch/local, bọc ROLLBACK)
-- Test: xóa user không xóa audit + snapshot còn giữ
-- ============================================================================

/*
BEGIN;

-- Seed 1 auth.users test (nếu MCP có permission — có thể cần role service_role).
-- Simplified: dùng org test + audit_logs seed.

INSERT INTO public.organizations(id, name, slug, status)
VALUES ('11111111-1111-1111-1111-1111b1_2_a00'::uuid, 'B1.2 test Org A', 'b1_2a-orgA', 'active');

-- Seed audit_logs row với org test.
INSERT INTO public.audit_logs(
  id, organization_id, actor_user_id, actor_email, action, target_type, target_id,
  organization_id_snapshot, organization_name_snapshot
)
VALUES (
  gen_random_uuid(),
  '11111111-1111-1111-1111-1111b1_2_a00'::uuid,
  NULL,
  'b1_2_test@example.com',
  'b1_2.test.action',
  'organization',
  '11111111-1111-1111-1111-1111b1_2_a00',
  '11111111-1111-1111-1111-1111b1_2_a00'::uuid,
  'B1.2 test Org A'
);

-- Verify audit_logs row có snapshot.
SELECT id, organization_id, organization_id_snapshot, organization_name_snapshot
FROM public.audit_logs
WHERE actor_email = 'b1_2_test@example.com';

-- Xóa org → FK SET NULL nên organization_id = NULL, snapshot GIỮ.
DELETE FROM public.organizations WHERE id = '11111111-1111-1111-1111-1111b1_2_a00'::uuid;

-- Verify sau xóa org: organization_id = NULL, snapshot vẫn còn.
SELECT id, organization_id, organization_id_snapshot, organization_name_snapshot
FROM public.audit_logs
WHERE actor_email = 'b1_2_test@example.com';
-- Kỳ vọng: 1 row, organization_id IS NULL, organization_id_snapshot IS NOT NULL,
-- organization_name_snapshot = 'B1.2 test Org A'.

ROLLBACK;
*/

-- ============================================================================
-- SECTION 5 (DESTRUCTIVE): xóa auth.users không xóa platform_audit_log
-- ============================================================================

/*
BEGIN;

-- Yêu cầu: có auth.users test tồn tại (dùng seed script hoặc test env).
-- Simplified — chỉ verify shape FK, không seed auth.users trong SQL:

-- Confirm FK delete_action = 'n' (SET NULL) cho actor_user_id.
SELECT
  con.conname,
  CASE con.confdeltype WHEN 'n' THEN 'SET NULL' ELSE 'NOT SET NULL' END AS action
FROM pg_constraint con
JOIN pg_class cl ON con.conrelid = cl.oid
JOIN pg_namespace ns ON cl.relnamespace = ns.oid
WHERE ns.nspname = 'public'
  AND con.contype = 'f'
  AND con.conname IN (
    'platform_audit_log_actor_user_id_fkey',
    'platform_admins_created_by_fkey'
  );

ROLLBACK;
*/

-- ============================================================================
-- SECTION 6 (READ-ONLY): retention policy metadata
-- ============================================================================
SELECT
  cl.relname AS table_name,
  pgd.description
FROM pg_class cl
JOIN pg_namespace ns ON cl.relnamespace = ns.oid
LEFT JOIN pg_description pgd ON pgd.objoid = cl.oid AND pgd.objsubid = 0
WHERE ns.nspname = 'public'
  AND cl.relname IN ('platform_audit_log', 'audit_logs');
-- Kỳ vọng: description chứa "Retention policy: 365 ngày".
