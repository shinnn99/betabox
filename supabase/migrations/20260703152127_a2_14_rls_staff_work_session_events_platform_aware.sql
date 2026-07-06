BEGIN;
DROP POLICY IF EXISTS "staff_work_session_events_select" ON public.staff_work_session_events;
CREATE POLICY "staff_work_session_events platform or org select"
  ON public.staff_work_session_events FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_work_session_events' AND policyname='staff_work_session_events platform or org select') THEN
    RAISE EXCEPTION 'A2 staff_work_session_events: policy not created';
  END IF;
END $$;
COMMIT;
