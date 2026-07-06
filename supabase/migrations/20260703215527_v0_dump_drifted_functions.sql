-- V0: Dump function drift về repo (thu drift, không đổi behavior)
--
-- 4 function tồn tại ở remote nhưng không có SQL trong repo migrations —
-- drift phát hiện lúc verify Q4.1 và V0 discovery. Dump body dạng CREATE
-- OR REPLACE để idempotent (chạy trên remote đã có = không đổi gì).
--
-- Danh sách drift thu:
--   1. app.current_role() — helper RLS đọc user_role từ JWT claim
--   2. app.count_active_owners(uuid) — đếm owner active của org (base function)
--   3. public.count_active_owners_app(uuid) — wrapper cho count_active_owners
--      (route src/app/api/users/[id]/route.ts gọi qua RPC)
--   4. public.custom_access_token_hook(jsonb) — Supabase Auth Hook set
--      organization_id + user_role vào JWT claims khi login
--
-- Verify sau apply: grep repo tìm được 4 tên function trong migrations/*.

-- ============================================================================
-- 1. app.current_role() — helper RLS đọc user_role từ JWT
-- ============================================================================
CREATE OR REPLACE FUNCTION app."current_role"()
RETURNS user_role
LANGUAGE sql
STABLE
SET search_path TO 'public', 'auth'
AS $function$
  select case
    when nullif(auth.jwt() ->> 'user_role', '') is null then null
    else (auth.jwt() ->> 'user_role')::user_role
  end;
$function$;

-- ============================================================================
-- 2. app.count_active_owners(uuid) — đếm owner active của org
-- ============================================================================
CREATE OR REPLACE FUNCTION app.count_active_owners(p_org_id uuid)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'app'
AS $function$
  select count(*)::int
  from public.user_profiles
  where organization_id = p_org_id
    and role = 'owner'
    and status = 'active';
$function$;

-- ============================================================================
-- 3. public.count_active_owners_app(uuid) — wrapper (route users/[id] gọi)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.count_active_owners_app(p_org_id uuid)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'app'
AS $function$
  select app.count_active_owners(p_org_id);
$function$;

-- ============================================================================
-- 4. public.custom_access_token_hook(jsonb) — Supabase Auth Hook
--    Set organization_id + user_role vào JWT claims khi login.
--    app.current_org_id() và app.current_role() đọc từ claims này.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
declare
  claims jsonb;
  v_org_id uuid;
  v_role public.user_role;
begin
  select organization_id, role
    into v_org_id, v_role
  from public.user_profiles
  where id = (event ->> 'user_id')::uuid;

  claims := event -> 'claims';

  if v_org_id is not null then
    claims := jsonb_set(claims, '{organization_id}', to_jsonb(v_org_id::text));
  else
    claims := jsonb_set(claims, '{organization_id}', 'null'::jsonb);
  end if;

  if v_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(v_role::text));
  else
    claims := jsonb_set(claims, '{user_role}', 'null'::jsonb);
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$function$;
