-- Đổi ngưỡng "quá lâu" mặc định 180s → 600s (10 phút) và cap
-- work_duration_seconds = max_order_seconds khi capped_timeout
-- (thay vì NULL) để UI có số cứng để hiển thị/thống kê.
--
-- Ngưỡng vẫn per-kho qua warehouses.packing_timing_config.max_order_seconds;
-- default coalesce đổi từ 180 → 600 chỉ áp cho kho chưa cấu hình.

create or replace function public.process_waybill_scan(p_raw_event_id uuid)
 returns table(status text, packing_event_id uuid, order_id uuid, waybill_code text, station_id uuid, warehouse_id uuid, staff_id uuid, work_session_id uuid, assignment_method text, previous_event_id uuid)
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
declare
  v_raw public.warehouse_scan_raw_events%rowtype;
  v_existing public.packing_events%rowtype;
  v_waybill text;
  v_business_date date;
  v_resolved record;
  v_fallback_seconds integer;
  v_order_id uuid;
  v_session public.staff_work_sessions%rowtype;
  v_session_id uuid;
  v_staff_id uuid;
  v_assignment text := 'none';
  v_status text;
  v_previous_id uuid;
  v_new_packing_id uuid;
  v_proof_camera_id uuid;
  -- Timing
  v_timing_cfg jsonb;
  v_max_order_seconds integer;
  v_open_prev public.packing_events%rowtype;
  v_open_duration integer;
  v_timing_status text;
  v_open_finalized_status text;
  v_open_finalized_duration integer;
begin
  -- 1) Idempotency short-circuit.
  select * into v_existing
  from public.packing_events pe
  where pe.raw_event_id = p_raw_event_id;

  if found then
    return query
      select v_existing.status, v_existing.id, v_existing.order_id,
             v_existing.waybill_code, v_existing.station_id,
             v_existing.warehouse_id, v_existing.staff_id,
             v_existing.work_session_id, v_existing.assignment_method,
             v_existing.previous_event_id;
    return;
  end if;

  -- 2) Load raw event.
  select * into v_raw
  from public.warehouse_scan_raw_events
  where id = p_raw_event_id;

  if not found then
    raise exception 'raw_event_not_found: %', p_raw_event_id
      using errcode = 'P0002';
  end if;
  if v_raw.scan_type <> 'waybill' then
    raise exception 'raw_event_not_waybill: scan_type=%', v_raw.scan_type
      using errcode = 'P0001';
  end if;

  v_waybill := upper(trim(v_raw.raw_value));
  v_business_date := (v_raw.scanned_at at time zone 'Asia/Ho_Chi_Minh')::date;

  if v_waybill = '' then
    v_status := 'invalid_code';
  else
    select r.station_id as st_id, r.warehouse_id as wh_id
      into v_resolved
    from public.resolve_scanner_at(
      v_raw.organization_id, v_raw.scanner_device_code, v_raw.scanned_at
    ) r;

    if v_resolved.st_id is null then
      v_status := 'unmapped_scanner';
    else
      insert into public.orders (organization_id, platform, waybill_code)
      values (v_raw.organization_id, 'unknown', v_waybill)
      on conflict (organization_id, platform, waybill_code)
      do update set updated_at = now()
      returning id into v_order_id;

      select * into v_session
      from public.staff_work_sessions sws
      where sws.station_id = v_resolved.st_id and sws.status = 'active'
      limit 1;

      if found then
        v_assignment := 'active_session';
        v_session_id := v_session.id;
        v_staff_id := v_session.staff_id;
      else
        select session_fallback_seconds into v_fallback_seconds
        from public.warehouses where id = v_resolved.wh_id;
        v_fallback_seconds := coalesce(v_fallback_seconds, 30);

        select * into v_session
        from public.staff_work_sessions sws
        where sws.station_id = v_resolved.st_id
          and sws.status in ('ended','forced_ended')
          and sws.ended_at is not null
          and sws.ended_at <= v_raw.scanned_at
          and sws.ended_at >= v_raw.scanned_at - make_interval(secs => v_fallback_seconds)
        order by sws.ended_at desc
        limit 1;

        if found then
          v_assignment := 'fallback_recent_session';
          v_session_id := v_session.id;
          v_staff_id := v_session.staff_id;
        end if;
      end if;

      -- Duplicate detection — chỉ trong cùng business_date.
      select pe.id into v_previous_id
      from public.packing_events pe
      where pe.organization_id = v_raw.organization_id
        and pe.waybill_code = v_waybill
        and pe.business_date = v_business_date
        and pe.status in ('valid','duplicated')
      order by pe.scanned_at desc
      limit 1;

      if v_previous_id is not null then
        v_status := 'duplicated';
      elsif v_session_id is null then
        v_status := 'no_active_session';
      else
        v_status := 'valid';
      end if;

      v_proof_camera_id := public.resolve_station_camera_at(
        v_raw.organization_id, v_resolved.st_id, v_raw.scanned_at
      );
    end if;
  end if;

  -- 3) Timing: chỉ event 'valid' mới được mở timing window.
  v_timing_status := 'not_applicable';

  if v_status = 'valid' then
    select packing_timing_config into v_timing_cfg
    from public.warehouses where id = v_resolved.wh_id;
    -- Default 600s (10 phút) — trước là 180s.
    v_max_order_seconds := coalesce(
      (v_timing_cfg ->> 'max_order_seconds')::int, 600
    );

    select * into v_open_prev
    from public.packing_events pe
    where pe.station_id = v_resolved.st_id
      and pe.timing_status = 'open'
    limit 1;

    if found then
      v_open_duration := extract(epoch from (v_raw.scanned_at - v_open_prev.work_started_at))::int;
      if v_open_duration > v_max_order_seconds then
        v_open_finalized_status := 'capped_timeout';
        -- Cap duration = max_order_seconds thay vì NULL để UI/stats có
        -- số cứng; work_ended_at giữ nguyên = scan-kế thật để clip
        -- pháp lý không bị cắt cụt.
        v_open_finalized_duration := v_max_order_seconds;
      else
        v_open_finalized_status := 'finalized_by_next_scan';
        v_open_finalized_duration := v_open_duration;
      end if;

      update public.packing_events
        set timing_status = v_open_finalized_status,
            work_ended_at = v_raw.scanned_at,
            work_duration_seconds = v_open_finalized_duration
        where id = v_open_prev.id;
    end if;

    v_timing_status := 'open';
  end if;

  insert into public.packing_events (
    organization_id, raw_event_id, order_id, waybill_code,
    warehouse_id, station_id, scanner_device_code,
    staff_id, work_session_id, scanned_at,
    status, assignment_method, previous_event_id,
    work_started_at, timing_status, closed_by_packing_event_id,
    proof_camera_id
  )
  values (
    v_raw.organization_id, p_raw_event_id, v_order_id, coalesce(v_waybill, ''),
    case when v_status = 'unmapped_scanner' then null else v_resolved.wh_id end,
    case when v_status = 'unmapped_scanner' then null else v_resolved.st_id end,
    v_raw.scanner_device_code,
    case when v_assignment <> 'none' then v_staff_id end,
    case when v_assignment <> 'none' then v_session_id end,
    v_raw.scanned_at,
    v_status, v_assignment, v_previous_id,
    case when v_timing_status = 'open' then v_raw.scanned_at end,
    v_timing_status,
    null,
    case when v_status = 'unmapped_scanner' then null else v_proof_camera_id end
  )
  returning id into v_new_packing_id;

  if v_open_prev.id is not null and v_status = 'valid' then
    update public.packing_events
      set closed_by_packing_event_id = v_new_packing_id
      where id = v_open_prev.id;
  end if;

  return query
    select v_status, v_new_packing_id, v_order_id, v_waybill,
           case when v_status = 'unmapped_scanner' then null else v_resolved.st_id end,
           case when v_status = 'unmapped_scanner' then null else v_resolved.wh_id end,
           case when v_assignment <> 'none' then v_staff_id end,
           case when v_assignment <> 'none' then v_session_id end,
           v_assignment, v_previous_id;
end;
$function$;
