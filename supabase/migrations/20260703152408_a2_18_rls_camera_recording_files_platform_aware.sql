BEGIN;
DROP POLICY IF EXISTS "camera_recording_files_select" ON public.camera_recording_files;
CREATE POLICY "camera_recording_files platform or org select"
  ON public.camera_recording_files FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='camera_recording_files' AND policyname='camera_recording_files platform or org select') THEN
    RAISE EXCEPTION 'A2 camera_recording_files: policy not created';
  END IF;
END $$;
COMMIT;
