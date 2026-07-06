-- ============================================================================
-- B1.1a security closure: REVOKE PUBLIC EXECUTE trên apply_camera_probes v1
-- và bảo đảm apply_camera_probes_v2 + enqueue_clip_generation fail-closed.
--
-- Bằng chứng MCP prod 2026-07-07 (has_function_privilege):
--   apply_camera_probes(jsonb):
--     PUBLIC        = TRUE  ← leak: anon/authenticated hưởng qua PUBLIC
--     anon          = TRUE
--     authenticated = TRUE
--     service_role  = TRUE
--     postgres      = TRUE (owner)
--   enqueue_clip_generation(...):
--     PUBLIC        = FALSE
--     anon          = FALSE
--     authenticated = FALSE
--     service_role  = TRUE (đúng chuẩn từ migration 20260706100100)
--
-- Sai lầm B1.1: migration 20260707140100 chỉ REVOKE FROM anon +
-- authenticated + PUBLIC. Nhưng ACL raw entry PUBLIC không tồn tại — với
-- function được tạo mà không REVOKE FROM PUBLIC ngay, PostgreSQL treat
-- default privilege PUBLIC EXECUTE là "implicit". Lệnh `REVOKE ... FROM
-- PUBLIC` cần thiết để chuyển từ implicit thành explicit-denied.
--
-- Fix B1.1a: REVOKE ALL FROM PUBLIC/anon/authenticated cả 2 function v1
-- và v2 (đảm bảo idempotent + explicit), verify có role `postgres` +
-- `service_role`. Test bằng has_function_privilege sau apply.
--
-- Caller verified:
--   src/app/api/agent/camera-probe/route.ts dùng createAdminClient() →
--   Supabase service-role client (service_role key, bypass RLS). REVOKE
--   PUBLIC không phá caller này.
--
-- KHÔNG chạy migration này lên shared DB trong phiên này. Chỉ tạo file +
-- verification script cập nhật.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. apply_camera_probes v1 — đóng PUBLIC leak
-- ----------------------------------------------------------------------------
-- REVOKE ALL FROM PUBLIC là mạnh nhất — xoá implicit default. Sau đó
-- explicit GRANT service_role cho route legacy fallback.
REVOKE ALL ON FUNCTION public.apply_camera_probes(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_camera_probes(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_camera_probes(jsonb) FROM authenticated;

-- Giữ service_role EXECUTE cho backward compat trong window drop (chờ
-- grep-CI xác nhận 0 caller — xem check-apply-camera-probes-legacy.mjs).
-- Dự kiến DROP v1 sau 2026-07-21 (2 tuần sau B1.1a) nếu 0 caller.
GRANT EXECUTE ON FUNCTION public.apply_camera_probes(jsonb) TO service_role;

-- ----------------------------------------------------------------------------
-- 2. apply_camera_probes_v2 — verify fail-closed từ đầu (idempotent với
--    migration B1.1 20260707140100)
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION giữ ACL cũ. Migration 20260707140100 đã
-- REVOKE PUBLIC + REVOKE anon + REVOKE authenticated + GRANT service_role
-- ngay khi CREATE. Ở đây REVOKE lại để idempotent nếu ai đó GRANT nhầm
-- sau này (defense-in-depth).
REVOKE ALL ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) TO service_role;

-- ----------------------------------------------------------------------------
-- 3. enqueue_clip_generation — verify fail-closed (đã đúng, thêm defense)
-- ----------------------------------------------------------------------------
-- Migration 20260706100100 đã REVOKE + GRANT service_role đúng. Ở đây
-- chỉ để idempotent phòng CREATE OR REPLACE tương lai vô tình mở lại.
REVOKE ALL ON FUNCTION public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) TO service_role;

-- ----------------------------------------------------------------------------
-- 4. Postcondition guard: sau apply, PUBLIC/anon/authenticated không được
--    có EXECUTE trên bất kỳ function nào ở trên.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  bad_grants int;
BEGIN
  -- has_function_privilege trả TRUE nếu role hưởng quyền qua ANY path
  -- (bao gồm PUBLIC). Postcondition: cả 3 role/PUBLIC không được có
  -- EXECUTE trên 3 function.
  SELECT count(*) INTO bad_grants
  FROM (
    SELECT p.oid FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN ('apply_camera_probes', 'apply_camera_probes_v2', 'enqueue_clip_generation')
  ) f
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
  WHERE has_function_privilege(r.role, f.oid, 'EXECUTE');

  IF bad_grants > 0 THEN
    RAISE EXCEPTION
      'b1_1a ACL postcondition failed: % anon/authenticated EXECUTE grant(s) still effective',
      bad_grants;
  END IF;

  -- Kiểm PUBLIC bằng ACL raw (has_function_privilege('public', ...) không
  -- hoạt động — 'public' là schema, không phải role).
  SELECT count(*) INTO bad_grants
  FROM (
    SELECT p.oid, p.proacl FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN ('apply_camera_probes', 'apply_camera_probes_v2', 'enqueue_clip_generation')
  ) f
  WHERE EXISTS (
    SELECT 1 FROM aclexplode(f.proacl) a
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  );

  IF bad_grants > 0 THEN
    RAISE EXCEPTION
      'b1_1a ACL postcondition failed: % function(s) still have explicit PUBLIC EXECUTE',
      bad_grants;
  END IF;
END $$;

COMMIT;
