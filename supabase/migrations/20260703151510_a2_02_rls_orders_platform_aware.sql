BEGIN;
DROP POLICY IF EXISTS "orders_select" ON public.orders;
CREATE POLICY "orders platform or org select"
  ON public.orders FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='orders' AND policyname='orders platform or org select') THEN
    RAISE EXCEPTION 'A2 orders: policy not created';
  END IF;
END $$;
COMMIT;
