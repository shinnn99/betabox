BEGIN;
DROP POLICY IF EXISTS "swa org read" ON public.staff_warehouse_assignments;
CREATE POLICY "staff_warehouse_assignments platform or org select"
  ON public.staff_warehouse_assignments FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_warehouse_assignments' AND policyname='staff_warehouse_assignments platform or org select') THEN
    RAISE EXCEPTION 'A2 staff_warehouse_assignments: policy not created';
  END IF;
END $$;
COMMIT;
