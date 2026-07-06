BEGIN;
DROP POLICY IF EXISTS "cameras_select" ON public.cameras;
CREATE POLICY "cameras platform or org select"
  ON public.cameras FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cameras' AND policyname='cameras platform or org select') THEN
    RAISE EXCEPTION 'A2 cameras: policy not created';
  END IF;
END $$;
COMMIT;
