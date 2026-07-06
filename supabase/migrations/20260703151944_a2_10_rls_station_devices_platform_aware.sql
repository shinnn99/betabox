BEGIN;
DROP POLICY IF EXISTS "station_devices_select" ON public.station_devices;
CREATE POLICY "station_devices platform or org select"
  ON public.station_devices FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='station_devices' AND policyname='station_devices platform or org select') THEN
    RAISE EXCEPTION 'A2 station_devices: policy not created';
  END IF;
END $$;
COMMIT;
