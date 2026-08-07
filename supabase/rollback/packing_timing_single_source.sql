-- ROLLBACK migration 20260807100000_packing_timing_single_source_180.
--
-- Khôi phục 4 function về ĐÚNG định nghĩa đang chạy trước khi apply
-- (dump từ pg_get_functiondef 2026-08-07 trước migration), và trả column
-- default về literal cũ.
--
-- Cách dùng: nếu sau apply thấy scan xử lý sai → chạy file này → hệ về
-- nguyên trạng, an toàn để chẩn đoán.
--
-- LƯU Ý: bản cũ có drift cố ý được ghi lại ở đây, KHÔNG sửa:
--   process_waybill_scan  coalesce(..., 600)
--   _finalize             coalesce(..., 180)
-- Đó chính là thứ migration sửa. Rollback = chấp nhận lại drift đó.

BEGIN;

-- 1) Column default về literal cũ.
ALTER TABLE public.warehouses
  ALTER COLUMN packing_timing_config
  SET DEFAULT jsonb_build_object(
    'timing_strategy', 'until_next_scan',
    'max_order_seconds', 180,
    'default_last_order_seconds', 60,
    'duplicate_boundary_grace_seconds', 5,
    'close_last_order_on_checkout', true,
    'video_pre_seconds', 5,
    'video_before_next_seconds', 2,
    'video_default_post_seconds', 60
  );

-- 2) process_waybill_scan: chỉ khối timing khác bản mới (đã verify bằng
-- md5 phần trước/sau khối này khớp tuyệt đối).
CREATE OR REPLACE FUNCTION public.process_waybill_scan(p_raw_event_id uuid)
 RETURNS TABLE(status text, packing_event_id uuid, order_id uuid, waybill_code text, station_id uuid, warehouse_id uuid, staff_id uuid, work_session_id uuid, assignment_method text, previous_event_id uuid)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

-- 3) _finalize_open_packing_for_station_at về bản literal.
CREATE OR REPLACE FUNCTION public._finalize_open_packing_for_station_at(
  p_station_id uuid,
  p_closed_at timestamp with time zone,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_open public.packing_events%rowtype;
  v_cfg jsonb;
  v_max_order_seconds integer;
  v_cap_multiplier numeric;
  v_default_last integer;
  v_close_on_checkout boolean;
  v_gap_seconds integer;
  v_threshold integer;
begin
  select * into v_open
  from public.packing_events pe
  where pe.station_id = p_station_id
    and pe.timing_status = 'open'
  limit 1;

  if not found then return; end if;

  select packing_timing_config into v_cfg
  from public.warehouses where id = v_open.warehouse_id;

  v_close_on_checkout := coalesce(
    (v_cfg ->> 'close_last_order_on_checkout')::boolean, true
  );
  if not v_close_on_checkout then
    return;  -- Theo config, không tự đóng.
  end if;

  v_max_order_seconds := coalesce((v_cfg ->> 'max_order_seconds')::int, 180);
  v_cap_multiplier := coalesce((v_cfg ->> 'checkout_gap_cap_multiplier')::numeric, 3);
  v_default_last := coalesce((v_cfg ->> 'default_last_order_seconds')::int, 60);
  v_threshold := (v_max_order_seconds * v_cap_multiplier)::int;
  v_gap_seconds := extract(epoch from (p_closed_at - v_open.work_started_at))::int;

  if v_gap_seconds > v_threshold then
    -- Staff quên scan tiếp / quên ra ca. Không tin duration thật.
    update public.packing_events
       set timing_status = 'default_estimated',
           work_ended_at = v_open.work_started_at + make_interval(secs => v_default_last),
           work_duration_seconds = v_default_last,
           timing_note = format(
             '%s · gap=%ss vượt ngưỡng %ss, ước lượng %ss',
             p_reason, v_gap_seconds, v_threshold, v_default_last
           )
     where id = v_open.id;
  else
    update public.packing_events
       set timing_status = 'finalized_by_checkout',
           work_ended_at = p_closed_at,
           work_duration_seconds = v_gap_seconds,
           timing_note = p_reason
     where id = v_open.id;
  end if;
end;
$function$;

-- 4) close_stale_sessions về bản literal 12.
CREATE OR REPLACE FUNCTION public.close_stale_sessions(p_organization_id uuid)
RETURNS TABLE(closed_sessions integer, closed_packing_events integer)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_session record;
  v_cfg jsonb;
  v_stale_hours integer;
  v_closed_at timestamptz;
  v_session_count integer := 0;
  v_packing_count integer := 0;
  v_open_count integer;
begin
  for v_session in
    select sws.*, w.packing_timing_config
    from public.staff_work_sessions sws
    join public.warehouses w on w.id = sws.warehouse_id
    where sws.status = 'active'
      and (p_organization_id is null or sws.organization_id = p_organization_id)
  loop
    v_cfg := v_session.packing_timing_config;
    v_stale_hours := coalesce((v_cfg ->> 'stale_session_hours')::int, 12);

    if v_session.started_at < now() - make_interval(hours => v_stale_hours) then
      v_closed_at := v_session.started_at + make_interval(hours => v_stale_hours);

      update public.staff_work_sessions
        set status = 'forced_ended',
            ended_at = v_closed_at,
            end_reason = 'auto_closed_stale'
        where id = v_session.id;

      insert into public.staff_work_session_events
        (organization_id, work_session_id, event_type, occurred_at, reason, metadata)
      values
        (v_session.organization_id, v_session.id,
         'forced_ended', v_closed_at, 'auto_closed_stale',
         jsonb_build_object(
           'stale_session_hours', v_stale_hours,
           'closed_by', 'close_stale_sessions'
         ));

      select count(*) into v_open_count
      from public.packing_events
      where station_id = v_session.station_id
        and timing_status = 'open';

      perform public._finalize_open_packing_for_station_at(
        v_session.station_id, v_closed_at,
        'auto_closed_stale_session'
      );

      v_session_count := v_session_count + 1;
      v_packing_count := v_packing_count + v_open_count;
    end if;
  end loop;

  return query select v_session_count, v_packing_count;
end;
$function$;

-- 5) list_stale_session_warnings về bản literal 4/12.
CREATE OR REPLACE FUNCTION public.list_stale_session_warnings(p_organization_id uuid)
RETURNS TABLE(session_id uuid, station_id uuid, station_code text, station_name text, staff_id uuid, staff_code text, staff_name text, started_at timestamp with time zone, hours_active numeric, warning_threshold_hours integer, auto_close_threshold_hours integer)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    sws.id,
    sws.station_id,
    ps.code,
    ps.name,
    sws.staff_id,
    sp.staff_code,
    sp.full_name,
    sws.started_at,
    round(extract(epoch from (now() - sws.started_at))::numeric / 3600, 1),
    coalesce((w.packing_timing_config ->> 'stale_warning_hours')::int, 4),
    coalesce((w.packing_timing_config ->> 'stale_session_hours')::int, 12)
  from public.staff_work_sessions sws
  join public.warehouses w on w.id = sws.warehouse_id
  join public.packing_stations ps on ps.id = sws.station_id
  join public.staff_profiles sp on sp.id = sws.staff_id
  where sws.organization_id = p_organization_id
    and sws.status = 'active'
    and sws.started_at < now() - make_interval(
      hours => coalesce((w.packing_timing_config ->> 'stale_warning_hours')::int, 4)
    )
  order by sws.started_at asc;
$function$;

-- 6) Hai function nguồn có thể để lại (không ai gọi sau rollback) hoặc bỏ:
-- DROP FUNCTION IF EXISTS public.resolve_packing_timing(uuid);
-- DROP FUNCTION IF EXISTS public.packing_timing_default_config();

COMMIT;
