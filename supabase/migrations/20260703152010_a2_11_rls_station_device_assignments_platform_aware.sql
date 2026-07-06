BEGIN;
DROP POLICY IF EXISTS "station_device_assignments_select" ON public.station_device_assignments;
CREATE POLICY "station_device_assignments platform or org select"
  ON public.station_device_assignments FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='station_device_assignments' AND policyname='station_device_assignments platform or org select') THEN
    RAISE EXCEPTION 'A2 station_device_assignments: policy not created';
  END IF;
END $$;
COMMIT;
