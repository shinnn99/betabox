BEGIN;
DROP POLICY IF EXISTS "staff org read" ON public.staff_profiles;
CREATE POLICY "staff_profiles platform or org select"
  ON public.staff_profiles FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_profiles' AND policyname='staff_profiles platform or org select') THEN
    RAISE EXCEPTION 'A2 staff_profiles: policy not created';
  END IF;
END $$;
COMMIT;
