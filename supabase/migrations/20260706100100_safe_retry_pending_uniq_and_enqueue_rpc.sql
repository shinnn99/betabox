-- Safe-retry hardening H2 + H4.
--
-- H2: partial unique index chặn > 1 pending row cho cùng packing_event_id.
--     Có sẵn index tương tự cho ready — thêm cho pending để 2 request
--     /watch hoặc 2 retry song song không tạo 2 row pending cùng lúc.
--     Verify prod 2026-07-06: 0 event có > 1 pending, an toàn tạo trực tiếp.
--
-- H4: RPC enqueue_clip_generation gộp INSERT pending row +
--     INSERT agent_commands vào 1 transaction — loại race
--     "command đã insert nhưng response mạng mất → backend xóa clip pending
--      → command mồ côi trỏ clip_id không tồn tại".
--
-- Idempotency: nếu conflict pending unique index (đã có generation đang
-- xử lý cho pe_id), RPC trả clip_id + command_id CŨ (fetch từ pending
-- gần nhất), không tạo generation mới. Caller quyết định xử tiếp thế nào.

-- ============================================================
-- H2: partial unique pending
-- ============================================================
create unique index if not exists uniq_order_proof_clip_pending_per_event
  on public.order_proof_clips (packing_event_id)
  where status = 'pending';

comment on index public.uniq_order_proof_clip_pending_per_event is
'Safe-retry: chỉ 1 pending generation cho mỗi packing_event tại 1 thời điểm. Song song với uniq_order_proof_clip_ready_per_event.';

-- ============================================================
-- H4: RPC atomic enqueue
-- ============================================================
--
-- Input:
--   p_organization_id, p_packing_event_id, p_camera_id, p_waybill_code,
--   p_agent_id — kênh nghiệp vụ.
--   p_clip_started_at, p_clip_ended_at, p_is_partial — bounds đã tính.
--   p_source_files, p_generation_params — jsonb, resolver trả về.
--   p_command_payload — jsonb payload gửi xuống agent (đã bao gồm clip_id;
--       backend caller build sau khi RPC trả clip_id — nên payload này
--       KHÔNG chứa clip_id, RPC sẽ tự merge vào).
--
-- Output row:
--   clip_id, command_id — cả 2 UUID mới tạo.
--   status = 'created' → tạo mới.
--   status = 'reused_existing_pending' → đã có pending row cho pe_id;
--     trả row cũ + command_id cũ. Caller có thể coi như enqueue thành công
--     hoặc từ chối tùy nghiệp vụ.
create or replace function public.enqueue_clip_generation(
  p_organization_id uuid,
  p_packing_event_id uuid,
  p_camera_id uuid,
  p_waybill_code text,
  p_agent_id uuid,
  p_clip_started_at timestamptz,
  p_clip_ended_at timestamptz,
  p_is_partial boolean,
  p_source_files jsonb,
  p_generation_params jsonb,
  p_command_payload jsonb
)
returns table(clip_id uuid, command_id uuid, result_status text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_clip_id uuid;
  v_command_id uuid;
  v_existing_pending public.order_proof_clips%rowtype;
  v_existing_command_id uuid;
  v_final_payload jsonb;
begin
  -- Sanity.
  if p_organization_id is null or p_packing_event_id is null
     or p_camera_id is null or p_agent_id is null
     or p_waybill_code is null or p_command_payload is null then
    raise exception 'enqueue_invalid_args' using errcode = 'P0001';
  end if;

  -- Cross-tenant guard: packing_event phải thuộc org đang gọi.
  perform 1 from public.packing_events
    where id = p_packing_event_id and organization_id = p_organization_id;
  if not found then
    raise exception 'enqueue_pe_not_in_org' using errcode = 'P0001';
  end if;

  -- Reuse existing pending nếu có (partial unique index → 1 pending/pe).
  --
  -- Reuse phải PASS 3 guard trước khi trả 'reused_existing_pending' — không
  -- được âm thầm coi mọi pending row là generation đang chạy hợp lệ:
  --   G1. Có active command (status IN ('pending','taken')) trỏ đúng clip_id.
  --   G2. replaces_clip_id trong payload cũ khớp với request hiện tại.
  --       Nếu khác — nghiệp vụ khác, không được reuse.
  --   G3. Payload command có clip_id đúng row pending.
  select * into v_existing_pending
  from public.order_proof_clips
  where packing_event_id = p_packing_event_id
    and status = 'pending'
  limit 1;

  if found then
    -- Fetch active command TRỎ đúng clip_id + status active.
    select id into v_existing_command_id
    from public.agent_commands
    where type = 'cut_clip'
      and organization_id = p_organization_id
      and status in ('pending', 'taken')
      and (payload->>'clip_id')::uuid = v_existing_pending.id
    order by created_at desc
    limit 1;

    -- G1: không có active command → pending row mồ côi. Ca này chỉ xảy ra
    -- nếu tx H4 cũ crash giữa 2 INSERT (không nên xảy ra sau H4), hoặc
    -- reaper timeout command mà không delete row pending. Raise để ops
    -- điều tra, KHÔNG trả success giả khiến /watch chờ mãi.
    if v_existing_command_id is null then
      raise exception 'enqueue_stale_pending_without_active_command: clip_id=%',
        v_existing_pending.id using errcode = 'P0001';
    end if;

    -- G2: replaces_clip_id trong payload cũ vs request hiện tại phải khớp
    -- (cả 2 null hoặc cùng uuid). Ca ngược: retry mới muốn thay clip A
    -- nhưng pending hiện tại đang thay clip B → nghiệp vụ khác nhau, KHÔNG
    -- reuse. Raise để retry endpoint xử tình huống này rõ ràng.
    declare
      v_old_replaces text;
      v_new_replaces text;
    begin
      select payload->>'replaces_clip_id' into v_old_replaces
      from public.agent_commands where id = v_existing_command_id;
      v_new_replaces := p_command_payload->>'replaces_clip_id';

      -- coalesce về '' để so sánh null bằng null (Postgres null <> null = null)
      if coalesce(v_old_replaces, '') <> coalesce(v_new_replaces, '') then
        raise exception 'enqueue_pending_replaces_mismatch: existing=% requested=%',
          coalesce(v_old_replaces, 'null'),
          coalesce(v_new_replaces, 'null') using errcode = 'P0001';
      end if;
    end;

    return query
      select v_existing_pending.id,
             v_existing_command_id,
             'reused_existing_pending'::text;
    return;
  end if;

  -- Tạo mới: INSERT pending row.
  -- progress_state để NULL — CHECK constraint chỉ cho ('encoding' | NULL).
  -- Agent sẽ chuyển sang 'encoding' khi thực sự bắt đầu cắt (qua callback
  -- outcome='encoding' ở clip-cut-result). Trước đó chỉ là "queued" khái
  -- niệm, không state DB riêng.
  insert into public.order_proof_clips(
    organization_id, packing_event_id, camera_id, waybill_code,
    status, cut_mode,
    source_files, generation_params,
    clip_started_at, clip_ended_at, is_partial
  )
  values (
    p_organization_id, p_packing_event_id, p_camera_id, p_waybill_code,
    'pending', 'copy',
    p_source_files, p_generation_params,
    p_clip_started_at, p_clip_ended_at, p_is_partial
  )
  returning id into v_clip_id;

  -- Merge clip_id vào payload trước khi insert command.
  v_final_payload := p_command_payload || jsonb_build_object('clip_id', v_clip_id::text);

  insert into public.agent_commands(organization_id, agent_id, type, payload)
  values (p_organization_id, p_agent_id, 'cut_clip', v_final_payload)
  returning id into v_command_id;

  return query select v_clip_id, v_command_id, 'created'::text;
end;
$function$;

comment on function public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) is
'Safe-retry H4: atomic INSERT order_proof_clips(pending) + agent_commands(cut_clip). Reuse pending nếu đã có.';

revoke execute on function public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) from public;
revoke execute on function public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) from anon;
revoke execute on function public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) from authenticated;
grant execute on function public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) to service_role;
