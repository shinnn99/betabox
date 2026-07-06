BEGIN;
DROP POLICY IF EXISTS "warehouse_scan_raw_events_select" ON public.warehouse_scan_raw_events;
CREATE POLICY "warehouse_scan_raw_events platform or org select"
  ON public.warehouse_scan_raw_events FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='warehouse_scan_raw_events' AND policyname='warehouse_scan_raw_events platform or org select') THEN
    RAISE EXCEPTION 'A2 warehouse_scan_raw_events: policy not created';
  END IF;
END $$;
COMMIT;
