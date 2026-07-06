BEGIN;
DROP POLICY IF EXISTS "warehouse_agents_select" ON public.warehouse_agents;
CREATE POLICY "warehouse_agents platform or org select"
  ON public.warehouse_agents FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='warehouse_agents' AND policyname='warehouse_agents platform or org select') THEN
    RAISE EXCEPTION 'A2 warehouse_agents: policy not created';
  END IF;
END $$;
COMMIT;
