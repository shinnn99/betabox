BEGIN;
DROP POLICY IF EXISTS "camera_recording_sessions_select" ON public.camera_recording_sessions;
CREATE POLICY "camera_recording_sessions platform or org select"
  ON public.camera_recording_sessions FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='camera_recording_sessions' AND policyname='camera_recording_sessions platform or org select') THEN
    RAISE EXCEPTION 'A2 camera_recording_sessions: policy not created';
  END IF;
END $$;
COMMIT;
