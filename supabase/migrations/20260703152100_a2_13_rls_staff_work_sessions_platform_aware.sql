BEGIN;
DROP POLICY IF EXISTS "staff_work_sessions_select" ON public.staff_work_sessions;
CREATE POLICY "staff_work_sessions platform or org select"
  ON public.staff_work_sessions FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_work_sessions' AND policyname='staff_work_sessions platform or org select') THEN
    RAISE EXCEPTION 'A2 staff_work_sessions: policy not created';
  END IF;
END $$;
COMMIT;
