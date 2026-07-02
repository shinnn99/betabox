-- Lát 3b-2 fix: Postgres cấm `FOR UPDATE` cùng SELECT với window function
-- (ERROR 0A000). Migration 20260701163504 dùng `row_number()` trong CTE
-- có `for update skip locked` → gọi RPC lỗi:
--   ERROR: FOR UPDATE is not allowed with window functions
--
-- Đây là lỗi tôi bỏ qua khi verify SQL: test filter precedence pass,
-- nhưng test đó KHÔNG có `FOR UPDATE` — không phát hiện conflict với
-- window function.
--
-- Sửa: tách lock (CTE `locked`) khỏi window function (CTE `numbered`).
-- Postgres cho phép lock ở CTE riêng, sau đó window trên set đã lock —
-- ngữ nghĩa không đổi, chỉ tách vòng.

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
    -- Lock các row pending phù hợp filter type. FOR UPDATE SKIP LOCKED
    -- chống race giữa các poll đồng thời. KHÔNG dùng window function
    -- ở CTE này (Postgres cấm cả hai cùng SELECT).
    select c.id, c.type, c.payload, c.created_at
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
    -- Đánh số per-type trên set ĐÃ LOCK.
    select id, type, payload, created_at,
           row_number() over (partition by type order by created_at) as rn_per_type
    from locked
  ),
  filtered as (
    -- Áp giới hạn per-type từ p_type_limits.
    select id, type, payload, created_at
    from numbered
    where (p_type_limits ? type is not true)
       or rn_per_type <= (p_type_limits ->> type)::int
  ),
  picked as (
    select id, type, payload
    from filtered
    order by created_at
    limit greatest(p_limit, 1)
  )
  update public.agent_commands c
  set status      = 'taken',
      taken_at    = now(),
      taken_count = c.taken_count + 1,
      updated_at  = now()
  from picked
  where c.id = picked.id
  returning c.id, c.type, c.payload;
end;
$$;

revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from public;
revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from anon;
revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from authenticated;
