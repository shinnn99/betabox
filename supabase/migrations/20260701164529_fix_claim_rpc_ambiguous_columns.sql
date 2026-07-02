-- Lát 3b-2 fix #2: Postgres ambiguous column reference trong plpgsql.
--
-- Migration 20260701164355 sửa bug FOR UPDATE + window function, nhưng
-- vẫn giữ CTE dùng tên cột `id, type, payload` không qualify — trùng
-- với tên cột trong `returns table (id uuid, type text, payload jsonb)`.
-- Postgres báo `column reference "id" is ambiguous` khi return query
-- chạy.
--
-- RPC gốc Lát 1 tránh được vì CTE `picked` chỉ select `c.id` (không
-- có id/type/payload unqualified).
--
-- Sửa: đổi tên cột CTE thành `_id, _type, _payload, _created_at,
-- _rn_per_type` để không đụng return names. Alias cuối cùng khi
-- returning c.id, c.type, c.payload — chỉ tham chiếu columns của
-- update, không plpgsql var.

create or replace function public.claim_agent_commands(
  p_agent_id      uuid,
  p_limit         int   default 20,
  p_exclude_types text[] default '{}',
  p_type_limits   jsonb  default '{}'::jsonb
)
returns table (
  id      uuid,
  type    text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with locked as (
    select c.id as _id, c.type as _type, c.payload as _payload, c.created_at as _created_at
    from public.agent_commands c
    where c.agent_id = p_agent_id
      and c.status = 'pending'
      and (
        array_length(p_exclude_types, 1) is null
        or not (c.type = any(p_exclude_types))
      )
    for update skip locked
  ),
  numbered as (
    select _id, _type, _payload, _created_at,
           row_number() over (partition by _type order by _created_at) as _rn_per_type
    from locked
  ),
  filtered as (
    select _id, _type, _payload, _created_at
    from numbered
    where (p_type_limits ? _type is not true)
       or _rn_per_type <= (p_type_limits ->> _type)::int
  ),
  picked as (
    select _id
    from filtered
    order by _created_at
    limit greatest(p_limit, 1)
  )
  update public.agent_commands c
  set status      = 'taken',
      taken_at    = now(),
      taken_count = c.taken_count + 1,
      updated_at  = now()
  from picked
  where c.id = picked._id
  returning c.id, c.type, c.payload;
end;
$$;

revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from public;
revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from anon;
revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from authenticated;
