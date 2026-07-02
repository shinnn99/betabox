-- Lát 3b-2: 1-in-flight encode ở agent local, KHÔNG có queue local.
--
-- Cơ chế: cloud agent_commands 'pending' CHÍNH LÀ queue. Agent khi busy
-- encode CHỈ POLL các job KHÔNG PHẢI cut_clip; khi rảnh, claim tối đa
-- 1 cut_clip mỗi lần. Không tăng visibility timeout, không đẻ trạng
-- thái vòng đời mới (`deferred`), không persist queue file.
--
-- Verify SQL precedence và grep caller đã làm TRƯỚC migration:
--   - `p_type_limits ? type is not true` precedence đúng (test 4 ca).
--   - claim_agent_commands chỉ có 1 caller (poll-commands route),
--     named args → CREATE OR REPLACE thêm param default cuối an toàn.

-- ---------------------------------------------------------------
-- 1) Extend claim_agent_commands: thêm 2 param default cuối.
--
-- p_exclude_types: mảng type KHÔNG được claim. Agent busy encode
--   truyền ARRAY['cut_clip'] → không claim cut_clip nào.
-- p_type_limits: map {type: max_count}. Agent rảnh truyền
--   '{"cut_clip":1}' → claim tối đa 1 cut_clip, các type khác không
--   giới hạn per-type (dùng p_limit).
--
-- Với type KHÔNG có trong p_type_limits → không giới hạn per-type,
-- rơi vào p_limit tổng.
-- ---------------------------------------------------------------
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
  with candidates as (
    select c.id, c.type, c.payload, c.created_at,
           row_number() over (partition by c.type order by c.created_at) as rn_per_type
    from public.agent_commands c
    where c.agent_id = p_agent_id
      and c.status = 'pending'
      and (
        array_length(p_exclude_types, 1) is null
        or not (c.type = any(p_exclude_types))
      )
    for update skip locked
  ),
  filtered as (
    select id, type, payload, created_at
    from candidates
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

-- Grants: revoke cả signature cũ (Lát 1) và signature mới (Lát 3b-2).
revoke execute on function public.claim_agent_commands(uuid, int) from public;
revoke execute on function public.claim_agent_commands(uuid, int) from anon;
revoke execute on function public.claim_agent_commands(uuid, int) from authenticated;
revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from public;
revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from anon;
revoke execute on function public.claim_agent_commands(uuid, int, text[], jsonb) from authenticated;

-- ---------------------------------------------------------------
-- 2) order_proof_clips.progress_state: chi tiết tức thời trong lúc
-- clip đang được xử lý. TÁCH khỏi status (vòng đời cuối cùng):
--   status='pending' + progress_state='encoding' → agent đang cắt.
--   status='ready'   + progress_state=null       → xong.
--   status='failed'  + progress_state=null       → lỗi.
--
-- CHECK đóng ('encoding') — chỉ giá trị đang dùng. Mở CHECK sau khi
-- có nhu cầu (VD 'burning' riêng khỏi 'encoding').
-- ---------------------------------------------------------------
alter table public.order_proof_clips
  add column progress_state text
  check (progress_state is null or progress_state in ('encoding'));
