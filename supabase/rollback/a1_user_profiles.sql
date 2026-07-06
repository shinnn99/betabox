-- ROLLBACK A1: khôi phục policy user_profiles về trạng thái TRƯỚC A1
--
-- Dumped từ pg_policies TRƯỚC khi áp A1. Áp file này = policy user_profiles
-- về đúng như trước, tenant chỉ thấy org mình theo pattern cũ (chưa platform-aware).
--
-- KHÔNG đụng "auth admin can read profiles" (supabase_auth_admin) — policy đó
-- giữ nguyên qua toàn bộ A1, chỉ authenticated policy bị sửa.
--
-- Cách dùng: nếu A1 apply xong test đỏ → chạy file này rollback → user_profiles
-- về policy cũ, an toàn để debug pattern.

BEGIN;

-- Xóa policy platform-aware nếu tồn tại (idempotent)
DROP POLICY IF EXISTS "user_profiles platform or org select" ON public.user_profiles;

-- Khôi phục policy cũ nếu chưa có (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='user_profiles'
      AND policyname='profiles org read'
  ) THEN
    CREATE POLICY "profiles org read" ON public.user_profiles
      FOR SELECT
      TO authenticated
      USING (organization_id = app.current_org_id());
  END IF;
END $$;

-- Verify rollback đúng trạng thái baseline
DO $$
DECLARE
  auth_admin_ok boolean;
  org_read_ok boolean;
  platform_aware_absent boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_profiles' AND policyname='auth admin can read profiles')
    INTO auth_admin_ok;
  SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_profiles' AND policyname='profiles org read')
    INTO org_read_ok;
  SELECT NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_profiles' AND policyname='user_profiles platform or org select')
    INTO platform_aware_absent;
  IF NOT (auth_admin_ok AND org_read_ok AND platform_aware_absent) THEN
    RAISE EXCEPTION 'Rollback A1 verify FAILED: auth_admin=%, org_read=%, platform_aware_absent=%',
      auth_admin_ok, org_read_ok, platform_aware_absent;
  END IF;
END $$;

COMMIT;
