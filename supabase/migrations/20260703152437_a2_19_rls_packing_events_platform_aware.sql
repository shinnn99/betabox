BEGIN;
DROP POLICY IF EXISTS "packing_events_select" ON public.packing_events;
CREATE POLICY "packing_events platform or org select"
  ON public.packing_events FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='packing_events' AND policyname='packing_events platform or org select') THEN
    RAISE EXCEPTION 'A2 packing_events: policy not created';
  END IF;
END $$;
COMMIT;
