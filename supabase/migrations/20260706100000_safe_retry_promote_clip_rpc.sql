-- Safe-retry pipeline: RPC promote_clip_generation
--
-- Đảm bảo transition ready(cũ) → superseded VÀ pending(mới) → ready xảy ra
-- ATOMIC trong 1 tx. Partial unique index uniq_order_proof_clip_ready_per_event
-- không cho 2 row cùng ready — writable CTE giải quyết bằng cách chạy
-- 2 UPDATE trong cùng statement (Postgres compile plan single-snapshot,
-- constraint check ở statement boundary).
--
-- 2 signature qua p_old_clip_id:
--   NULL  → lần cắt đầu, chỉ promote pending → ready (không có row cũ)
--   uuid  → retry, flip đôi (row cũ superseded + row mới ready)
--
-- Idempotent: nếu callback bị gửi lại (network retry) sau khi promote
-- lần đầu đã thành công, RPC trả 'already_promoted' thay vì raise.
-- Điều kiện idempotent match: new clip đã ready + bucket_path đúng +
-- (nếu p_old_clip_id != null) old clip đã superseded.
--
-- Guard cross-tenant + cross-event:
--   - new và old cùng packing_event_id.
--   - new và old cùng organization (qua packing_event → warehouses/orgs).
--   - new != old.
--   - Không tồn tại ready row nào KHÁC cho pe_id (partial index đã lo).
--
-- Quyền:
--   REVOKE PUBLIC + anon + authenticated.
--   GRANT service_role only. Route agent-callback dùng admin client
--   (service_role), không dùng session client.

create or replace function public.promote_clip_generation(
  p_new_clip_id uuid,
  p_packing_event_id uuid,
  p_bucket_path text,
  p_old_clip_id uuid default null
)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_new_row public.order_proof_clips%rowtype;
  v_old_row public.order_proof_clips%rowtype;
  v_new_count int;
  v_old_count int;
begin
  -- 0) Basic sanity.
  if p_new_clip_id is null or p_packing_event_id is null or p_bucket_path is null then
    raise exception 'promote_invalid_args' using errcode = 'P0001';
  end if;
  if p_old_clip_id is not null and p_old_clip_id = p_new_clip_id then
    raise exception 'promote_same_id_conflict' using errcode = 'P0001';
  end if;

  -- 1) Load new row, verify thuộc đúng pe.
  select * into v_new_row
  from public.order_proof_clips
  where id = p_new_clip_id;

  if not found then
    raise exception 'promote_new_not_found' using errcode = 'P0001';
  end if;
  if v_new_row.packing_event_id <> p_packing_event_id then
    raise exception 'promote_new_wrong_pe' using errcode = 'P0001';
  end if;

  -- 2) Nếu có old, load + verify cross-event + cross-tenant.
  if p_old_clip_id is not null then
    select * into v_old_row
    from public.order_proof_clips
    where id = p_old_clip_id;

    if not found then
      raise exception 'promote_old_not_found' using errcode = 'P0001';
    end if;
    if v_old_row.packing_event_id <> p_packing_event_id then
      raise exception 'promote_old_wrong_pe' using errcode = 'P0001';
    end if;
    if v_old_row.organization_id <> v_new_row.organization_id then
      raise exception 'promote_cross_tenant' using errcode = 'P0001';
    end if;
  end if;

  -- 3) Idempotent short-circuit: callback bị retry sau khi promote đã xong.
  --    Match yêu cầu: new đã ready + bucket_path đúng, và (nếu có old) old đã superseded.
  if v_new_row.status = 'ready'
     and v_new_row.bucket_path = p_bucket_path
     and (
       p_old_clip_id is null
       or v_old_row.status = 'superseded'
     )
  then
    return 'already_promoted';
  end if;

  -- 4) Trạng thái không đúng để promote (không phải idempotent hit thuần
  --    túy, cũng không phải trạng thái hợp lệ để chuyển) → raise.
  --    Ví dụ ca lỗi:
  --      - new đã ready nhưng bucket_path KHÁC → có ai khác promote path khác;
  --      - new = failed hoặc superseded → không được promote.
  if v_new_row.status = 'ready' and v_new_row.bucket_path <> p_bucket_path then
    raise exception 'promote_new_ready_different_bucket_path' using errcode = 'P0001';
  end if;
  if v_new_row.status <> 'pending' then
    raise exception 'promote_new_bad_status: %', v_new_row.status using errcode = 'P0001';
  end if;
  if p_old_clip_id is not null and v_old_row.status not in ('ready', 'superseded') then
    raise exception 'promote_old_bad_status: %', v_old_row.status using errcode = 'P0001';
  end if;

  -- 5) Thực thi.
  if p_old_clip_id is null then
    -- Lần cắt đầu.
    update public.order_proof_clips
    set
      status = 'ready',
      bucket_path = p_bucket_path,
      bucket_uploaded_at = now(),
      generated_at = now()
    where id = p_new_clip_id
      and packing_event_id = p_packing_event_id
      and status = 'pending';

    get diagnostics v_new_count = row_count;
    if v_new_count <> 1 then
      raise exception 'promote_new_failed: expected 1 row updated, got %', v_new_count
        using errcode = 'P0001';
    end if;

    return 'promoted_first';
  end if;

  -- 6) Retry: flip đôi trong 1 writable CTE (constraint check ở
  -- statement boundary → không vi phạm partial unique index).
  --
  -- Nếu old đã superseded rồi (nhánh idempotent partial: new còn pending
  -- nhưng old đã superseded trong lần callback trước), CTE dưới sẽ update
  -- 0 row cho old_flip → raise. Đó là trạng thái crash-in-the-middle
  -- HIẾM; tốt hơn là raise để ops điều tra hơn là auto-recover.
  with old_flip as (
    update public.order_proof_clips
    set status = 'superseded'
    where id = p_old_clip_id
      and packing_event_id = p_packing_event_id
      and status = 'ready'
    returning id
  ),
  new_flip as (
    update public.order_proof_clips
    set
      status = 'ready',
      bucket_path = p_bucket_path,
      bucket_uploaded_at = now(),
      generated_at = now()
    from old_flip
    where public.order_proof_clips.id = p_new_clip_id
      and public.order_proof_clips.packing_event_id = p_packing_event_id
      and public.order_proof_clips.status = 'pending'
    returning public.order_proof_clips.id
  )
  select
    (select count(*) from old_flip),
    (select count(*) from new_flip)
  into v_old_count, v_new_count;

  if v_old_count <> 1 or v_new_count <> 1 then
    raise exception 'promote_flip_failed: old=% new=%', v_old_count, v_new_count
      using errcode = 'P0001';
  end if;

  return 'promoted_retry';
end;
$function$;

comment on function public.promote_clip_generation(uuid, uuid, text, uuid) is
'Safe-retry: atomic promote pending→ready + supersede ready cũ. NULL p_old_clip_id = lần cắt đầu. Idempotent: callback lặp trả already_promoted.';

-- Chỉ service_role được gọi (route agent-callback dùng admin client).
revoke execute on function public.promote_clip_generation(uuid, uuid, text, uuid) from public;
revoke execute on function public.promote_clip_generation(uuid, uuid, text, uuid) from anon;
revoke execute on function public.promote_clip_generation(uuid, uuid, text, uuid) from authenticated;
grant execute on function public.promote_clip_generation(uuid, uuid, text, uuid) to service_role;
