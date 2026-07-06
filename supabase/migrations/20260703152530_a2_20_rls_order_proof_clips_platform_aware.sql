BEGIN;
DROP POLICY IF EXISTS "order_proof_clips_select" ON public.order_proof_clips;
CREATE POLICY "order_proof_clips platform or org select"
  ON public.order_proof_clips FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='order_proof_clips' AND policyname='order_proof_clips platform or org select') THEN
    RAISE EXCEPTION 'A2 order_proof_clips: policy not created';
  END IF;
END $$;
COMMIT;
