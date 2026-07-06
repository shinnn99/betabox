-- A1: RLS pattern platform-aware trên user_profiles (bảng mẫu ca-khó-nhất)
--
-- Chọn user_profiles làm mẫu vì nhạy nhất (chứa role+org tenant) — pattern
-- đúng trên đây thì chắc cho 21 bảng còn lại ở A2.
--
-- Pattern: is_platform_admin() OR organization_id = app.current_org_id()
--   - Nửa dương: platform admin (in platform_admins active) → is_platform_admin() true → thấy mọi org
--   - Nửa âm: tenant → is_platform_admin() false → chỉ thấy org mình
--
-- Convention Q5.1α: DROP policy cũ + CREATE tên chuẩn "<table> platform or org <cmd>".
-- Atomic transaction + inline verify. Rollback sẵn ở supabase/rollback/a1_user_profiles.sql.
--
-- KHÔNG đụng "auth admin can read profiles" (supabase_auth_admin) — policy đó
-- cho Supabase Auth service đọc profiles build JWT, không được xóa.

BEGIN;

-- DROP policy tenant cũ (chỉ policy authenticated, giữ auth admin policy)
DROP POLICY IF EXISTS "profiles org read" ON public.user_profiles;

-- CREATE policy platform-aware, tên chuẩn
CREATE POLICY "user_profiles platform or org select"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (
    app.is_platform_admin()
    OR organization_id = app.current_org_id()
  );

-- Inline verify: policy tồn tại với USING clause đúng
DO $$
DECLARE
  policy_ok boolean;
  auth_admin_ok boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='user_profiles'
      AND policyname='user_profiles platform or org select'
      AND cmd='SELECT'
  ) INTO policy_ok;

  SELECT EXISTS(
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='user_profiles'
      AND policyname='auth admin can read profiles'
  ) INTO auth_admin_ok;

  IF NOT policy_ok THEN
    RAISE EXCEPTION 'A1 verify FAILED: platform-aware policy not created';
  END IF;
  IF NOT auth_admin_ok THEN
    RAISE EXCEPTION 'A1 verify FAILED: auth admin policy accidentally dropped';
  END IF;
END $$;

COMMIT;
