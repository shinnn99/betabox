-- A2 bảng 1/21: staff_qr_credentials (nhóm 1 nhạy-ít-data, có role check)
-- Pattern platform-aware với role check trong nhánh tenant.

BEGIN;

DROP POLICY IF EXISTS "qr org admin read" ON public.staff_qr_credentials;

CREATE POLICY "staff_qr_credentials platform or org admin select"
  ON public.staff_qr_credentials
  FOR SELECT
  TO authenticated
  USING (
    app.is_platform_admin()
    OR (
      organization_id = app.current_org_id()
      AND app."current_role"() = ANY (ARRAY['owner'::user_role, 'admin'::user_role, 'warehouse_manager'::user_role])
    )
  );

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_qr_credentials' AND policyname='staff_qr_credentials platform or org admin select') THEN
    RAISE EXCEPTION 'A2 staff_qr_credentials: platform-aware policy not created';
  END IF;
END $$;

COMMIT;
