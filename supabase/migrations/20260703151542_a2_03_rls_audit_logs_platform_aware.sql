BEGIN;
DROP POLICY IF EXISTS "audit org read by admins" ON public.audit_logs;
CREATE POLICY "audit_logs platform or org admin select"
  ON public.audit_logs FOR SELECT TO authenticated
  USING (
    app.is_platform_admin()
    OR (
      organization_id = app.current_org_id()
      AND app."current_role"() = ANY (ARRAY['owner'::user_role, 'admin'::user_role])
    )
  );
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs' AND policyname='audit_logs platform or org admin select') THEN
    RAISE EXCEPTION 'A2 audit_logs: policy not created';
  END IF;
END $$;
COMMIT;
