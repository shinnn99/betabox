BEGIN;
DROP POLICY IF EXISTS "warehouses org read" ON public.warehouses;
CREATE POLICY "warehouses platform or org select"
  ON public.warehouses FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='warehouses' AND policyname='warehouses platform or org select') THEN
    RAISE EXCEPTION 'A2 warehouses: policy not created';
  END IF;
END $$;
COMMIT;
