BEGIN;
DROP POLICY IF EXISTS "staff_qr_scan_results_select" ON public.staff_qr_scan_results;
CREATE POLICY "staff_qr_scan_results platform or org select"
  ON public.staff_qr_scan_results FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_qr_scan_results' AND policyname='staff_qr_scan_results platform or org select') THEN
    RAISE EXCEPTION 'A2 staff_qr_scan_results: policy not created';
  END IF;
END $$;
COMMIT;
