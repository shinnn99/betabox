-- P0 security fix: lock down public.resolve_scanner_by_identity(uuid, jsonb).
--
-- Background:
--   * The function is SECURITY DEFINER and runs as its owner (postgres),
--     so it bypasses RLS when callers exec it. With the previous grants,
--     any holder of the publishable anon key could call it via
--     /rest/v1/rpc/resolve_scanner_by_identity and enumerate the
--     org's scanner identity ↔ station_device mapping.
--   * The only caller in code is the server-side warehouse discovery
--     route, which uses the service-role client. service_role has its
--     own privilege model in Supabase and is not affected by the
--     REVOKEs below.
--
-- Rollback note (manual, not auto-applied): re-granting EXECUTE to
-- anon/authenticated/PUBLIC would restore the vulnerability. Only do it
-- by hand after confirming the function no longer leaks anything
-- sensitive. The search_path tightening below is safe to keep.

REVOKE EXECUTE ON FUNCTION public.resolve_scanner_by_identity(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_scanner_by_identity(uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.resolve_scanner_by_identity(uuid, jsonb) FROM authenticated;

-- Tighten search_path. Existing config was `search_path=public` which
-- is not enough: pg_temp must be pinned explicitly so a malicious
-- caller can't shadow a function/table the body references. Owners of
-- SECURITY DEFINER bodies should always pin search_path to a known
-- whitelist that ends with pg_temp.
ALTER FUNCTION public.resolve_scanner_by_identity(uuid, jsonb)
  SET search_path = public, pg_temp;
