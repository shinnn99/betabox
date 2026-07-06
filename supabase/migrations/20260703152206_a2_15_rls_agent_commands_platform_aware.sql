-- agent_commands hiện chưa có SELECT policy cho authenticated (default-deny).
-- Thêm SELECT policy platform-aware để platform impersonate xem được +
-- tenant đọc org mình. Agent-ghi qua service role bypass.
BEGIN;
CREATE POLICY "agent_commands platform or org select"
  ON public.agent_commands FOR SELECT TO authenticated
  USING (app.is_platform_admin() OR organization_id = app.current_org_id());
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='agent_commands' AND policyname='agent_commands platform or org select') THEN
    RAISE EXCEPTION 'A2 agent_commands: policy not created';
  END IF;
END $$;
COMMIT;
