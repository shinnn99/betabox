-- Gom định nghĩa packing_timing_config về MỘT nguồn, chốt ngưỡng 180s.
--
-- Trước migration này cùng một khái niệm nằm rải ở 4 chỗ với giá trị
-- KHÁC nhau:
--   warehouses.packing_timing_config column default   max_order_seconds 180
--   process_waybill_scan                              coalesce(..., 600)
--   _finalize_open_packing_for_station_at             coalesce(..., 180)
--   close_stale_sessions / list_stale_session_warnings  stale_* 12/4 literal
--
-- Hệ quả đã quan sát được: migration 20260704200000 đổi fallback trong
-- process_waybill_scan 180 → 600, nhưng column default vẫn ghi sẵn key
-- 180 nên nhánh 600 KHÔNG BAO GIỜ chạy. Kho Đại Kim tạo 2026-07-24
-- (20 ngày sau) vẫn nhận 180. Ba nơi định nghĩa = drift âm thầm.
--
-- Chốt 2026-08-07: đồng bộ về 180, KHÔNG nâng lên 600.
-- Lý do không nâng: pipeline proof clip chưa chịu nổi. Trần upload đo
-- được của project là 50 MiB; camera Đại Kim ~256 KB/s → clip 190s đã
-- ~47 MB. Nâng ngưỡng nghiệp vụ lên 600 sẽ sinh clip ~150 MB, fail
-- upload chắc chắn. Ngưỡng nghiệp vụ chỉ được nâng SAU khi lớp giới hạn
-- kỹ thuật của proof pipeline xử lý được độ dài đó.
--
-- Hai lớp này là hai khái niệm khác nhau, đừng gộp lại:
--   max_order_seconds        → nghiệp vụ: đánh dấu packing session bất thường
--   trần dung lượng/độ dài clip → kỹ thuật: giới hạn của proof pipeline
--
-- Migration này KHÔNG đổi hành vi của 2 kho đang chạy: cả hai đều đã có
-- key max_order_seconds trong config (600 và 180), nên nhánh fallback
-- không được dùng tới. Nó chỉ đảm bảo kho tạo MỚI và các function đọc
-- cùng một bộ số.

-- 1) Nguồn duy nhất của mọi giá trị mặc định.
create or replace function public.packing_timing_default_config()
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'timing_strategy', 'until_next_scan',
    -- Nghiệp vụ: quá ngưỡng này thì đơn bị đánh capped_timeout.
    'max_order_seconds', 180,
    -- Đóng đơn cuối khi nhân viên ra ca.
    'close_last_order_on_checkout', true,
    -- Ra ca cách scan cuối quá max_order_seconds * bội số này → không tin
    -- duration thật nữa, dùng default_last_order_seconds.
    'checkout_gap_cap_multiplier', 3,
    'default_last_order_seconds', 60,
    'duplicate_boundary_grace_seconds', 5,
    -- Ca làm việc treo: cảnh báo ở 4h, cron tự đóng ở 12h.
    'stale_warning_hours', 4,
    'stale_session_hours', 12,
    -- Biên clip.
    'video_pre_seconds', 5,
    'video_before_next_seconds', 2,
    'video_default_post_seconds', 60
  );
$function$;

-- 2) Đọc config của một kho = mặc định phủ bởi giá trị đã lưu.
-- Kho lưu thiếu key (VD Đại Kim không có stale_session_hours) tự động
-- nhận mặc định, không cần mỗi function tự coalesce lấy một literal.
create or replace function public.resolve_packing_timing(p_warehouse_id uuid)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select public.packing_timing_default_config()
         || coalesce(w.packing_timing_config, '{}'::jsonb)
  from public.warehouses w
  where w.id = p_warehouse_id;
$function$;

-- 3) Column default trỏ vào cùng nguồn — không chép lại literal.
alter table public.warehouses
  alter column packing_timing_config
  set default public.packing_timing_default_config();

-- 4) process_waybill_scan: bỏ coalesce(..., 600), đọc qua resolver.
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
    -- Một nguồn: resolve_packing_timing đã phủ mặc định lên config kho.
    v_timing_cfg := public.resolve_packing_timing(v_resolved.wh_id);
    v_max_order_seconds := (v_timing_cfg ->> 'max_order_seconds')::int;

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

-- 5) _finalize_open_packing_for_station_at: bỏ 3 literal, đọc qua resolver.
create or replace function public._finalize_open_packing_for_station_at(
  p_station_id uuid,
  p_closed_at timestamp with time zone,
  p_reason text
)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
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

  v_cfg := public.resolve_packing_timing(v_open.warehouse_id);

  v_close_on_checkout := (v_cfg ->> 'close_last_order_on_checkout')::boolean;
  if not v_close_on_checkout then
    return;  -- Theo config, không tự đóng.
  end if;

  v_max_order_seconds := (v_cfg ->> 'max_order_seconds')::int;
  v_cap_multiplier := (v_cfg ->> 'checkout_gap_cap_multiplier')::numeric;
  v_default_last := (v_cfg ->> 'default_last_order_seconds')::int;
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

-- 6) close_stale_sessions: bỏ literal 12.
create or replace function public.close_stale_sessions(p_organization_id uuid)
returns table(closed_sessions integer, closed_packing_events integer)
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_session record;
  v_stale_hours integer;
  v_closed_at timestamptz;
  v_session_count integer := 0;
  v_packing_count integer := 0;
  v_open_count integer;
begin
  for v_session in
    select sws.*
    from public.staff_work_sessions sws
    where sws.status = 'active'
      and (p_organization_id is null or sws.organization_id = p_organization_id)
  loop
    v_stale_hours := (
      public.resolve_packing_timing(v_session.warehouse_id) ->> 'stale_session_hours'
    )::int;

    if v_session.started_at < now() - make_interval(hours => v_stale_hours) then
      -- Pin closed_at tại started_at + stale_hours (không phải now()), để
      -- duration không nhảy linh tinh khi cron chạy muộn.
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

      -- Đếm packing event open tại station trước khi finalize.
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

-- 7) list_stale_session_warnings: bỏ literal 4 và 12.
create or replace function public.list_stale_session_warnings(p_organization_id uuid)
returns table(session_id uuid, station_id uuid, station_code text, station_name text, staff_id uuid, staff_code text, staff_name text, started_at timestamp with time zone, hours_active numeric, warning_threshold_hours integer, auto_close_threshold_hours integer)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
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
    (public.resolve_packing_timing(w.id) ->> 'stale_warning_hours')::int,
    (public.resolve_packing_timing(w.id) ->> 'stale_session_hours')::int
  from public.staff_work_sessions sws
  join public.warehouses w on w.id = sws.warehouse_id
  join public.packing_stations ps on ps.id = sws.station_id
  join public.staff_profiles sp on sp.id = sws.staff_id
  where sws.organization_id = p_organization_id
    and sws.status = 'active'
    and sws.started_at < now() - make_interval(
      hours => (public.resolve_packing_timing(w.id) ->> 'stale_warning_hours')::int
    )
  order by sws.started_at asc;
$function$;
