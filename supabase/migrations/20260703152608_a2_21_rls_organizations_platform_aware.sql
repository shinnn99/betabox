-- Ngoại lệ NHÓM 3: organizations (dùng id, không organization_id).
-- Sửa CẢ SELECT + UPDATE. UPDATE giữ role-check owner/admin trong nhánh tenant.
BEGIN;

DROP POLICY IF EXISTS "org self read" ON public.organizations;
DROP POLICY IF EXISTS "org self update" ON public.organizations;

CREATE POLICY "organizations platform or org select"
  ON public.organizations FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR id = app.current_org_id());

CREATE POLICY "organizations platform or org admin update"
  ON public.organizations FOR UPDATE TO authenticated
  USING (
    app.is_platform_admin()
    OR (
      id = app.current_org_id()
      AND app."current_role"() = ANY (ARRAY['owner'::user_role, 'admin'::user_role])
    )
  )
  WITH CHECK (
    app.is_platform_admin()
    OR (
      id = app.current_org_id()
      AND app."current_role"() = ANY (ARRAY['owner'::user_role, 'admin'::user_role])
    )
  );

DO $$
DECLARE sel_ok boolean; upd_ok boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='organizations' AND policyname='organizations platform or org select') INTO sel_ok;
  SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='organizations' AND policyname='organizations platform or org admin update') INTO upd_ok;
  IF NOT (sel_ok AND upd_ok) THEN
    RAISE EXCEPTION 'A2 organizations: sel=%, upd=%', sel_ok, upd_ok;
  END IF;
END $$;

COMMIT;
