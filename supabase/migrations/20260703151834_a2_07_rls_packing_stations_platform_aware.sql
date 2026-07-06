BEGIN;
DROP POLICY IF EXISTS "packing_stations_select" ON public.packing_stations;
CREATE POLICY "packing_stations platform or org select"
  ON public.packing_stations FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='packing_stations' AND policyname='packing_stations platform or org select') THEN
    RAISE EXCEPTION 'A2 packing_stations: policy not created';
  END IF;
END $$;
COMMIT;
