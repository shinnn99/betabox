-- ============================================================================
-- Vá lỗi hàm vỡ khi gặp mã không hợp lệ (kho Đại Kim, 25/09/2026)
--
-- Sau khi áp 20260925120000 (chặn chuỗi không có dáng mã vận đơn), mọi
-- lượt quét rơi vào nhánh `invalid_code` đều làm hàm ném lỗi:
--
--   record "v_resolved" is not assigned yet
--
-- Vì `v_resolved` chỉ được gán trong nhánh mã hợp lệ, còn câu INSERT ở
-- cuối hàm thì LUÔN đọc `v_resolved.wh_id` / `v_resolved.st_id`.
--
-- Hậu quả nếu không vá: quét trúng mã QR link TikTok là hàm vỡ, lượt quét
-- KHÔNG được ghi lại dưới bất kỳ dạng nào — tệ hơn cả trước khi vá, vì ít
-- nhất trước đó nó còn ghi (sai) thành một đơn.
--
-- Lỗi này nằm sẵn từ lâu ở nhánh chuỗi rỗng; chuỗi rỗng hiếm nên chưa ai
-- gặp.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

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
  -- Hàng hoàn
  v_event_kind text := 'outbound';
  v_return_kind text;
  v_outbound_event_id uuid;
  v_inspection_result text;
  v_close_reason text;
  v_lookback_days integer;
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

  -- v_resolved CHỈ được gán trong nhánh mã hợp lệ, nhưng câu INSERT bên
  -- dưới luôn đọc v_resolved.wh_id / v_resolved.st_id. PL/pgSQL ném lỗi
  -- "record v_resolved is not assigned yet" nếu record chưa được gán lần
  -- nào — hàm vỡ, lượt quét mất trắng thay vì được ghi là mã sai.
  --
  -- Lỗi này nằm sẵn từ lâu ở nhánh chuỗi rỗng, nhưng chuỗi rỗng gần như
  -- không xảy ra nên không ai gặp. Tới khi chặn mã không đúng dáng
  -- (25/09/2026) thì nhánh đó chạy thật và lộ ra ngay.
  select null::uuid as st_id, null::uuid as wh_id into v_resolved;

  if not public.is_waybill_like(v_waybill) then
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
        and pe.event_kind = 'outbound'
        and pe.status in ('valid','duplicated')
      order by pe.scanned_at desc
      limit 1;

      if v_previous_id is not null then
        v_status := 'duplicated';
      else
        -- LƯỚI AN TOÀN: mã này đã đóng đi ở NGÀY KHÁC trong khoảng nhìn lại.
        -- Kiện giao thất bại quay về mang đúng mã cũ, nên đây gần như chắc
        -- chắn là hàng hoàn bị quét ở bàn đóng hàng. Ghi thành kiện hoàn
        -- 'suspect', đóng ngay: KHÔNG đếm vào số đơn, KHÔNG đụng vào đơn
        -- đang mở của bàn. Trước migration này, nó thành đơn 'valid' mới và
        -- được đếm lần hai.
        v_timing_cfg := public.resolve_packing_timing(v_resolved.wh_id);
        v_lookback_days := coalesce((v_timing_cfg ->> 'return_lookback_days')::int, 60);

        select pe.id into v_outbound_event_id
        from public.packing_events pe
        where pe.organization_id = v_raw.organization_id
          and pe.waybill_code = v_waybill
          and pe.event_kind = 'outbound'
          and pe.status = 'valid'
          and pe.business_date < v_business_date
          and pe.scanned_at >= v_raw.scanned_at - make_interval(days => v_lookback_days)
        order by pe.scanned_at desc
        limit 1;

        -- CHUA MO CA thi khong ghi hinh, nen khong co bang chung: moi luot
        -- quet deu dung o 'no_active_session', ke ca khi luoi an toan nhan
        -- ra day la hang hoan. Truoc 23/09/2026 nhanh 'return_suspect' chay
        -- truoc nen luot quet khong ca van co gio bat dau/ket thuc va van
        -- bam cat clip duoc, trong khi khong co doan video nao.
        if v_session_id is null then
          v_status := 'no_active_session';
        elsif v_outbound_event_id is not null then
          v_event_kind := 'return';
          v_return_kind := 'suspect';
          v_inspection_result := 'unchecked';
          v_close_reason := 'suspect';
          v_status := 'return_suspect';
        else
          v_status := 'valid';
        end if;
      end if;

      v_proof_camera_id := public.resolve_station_camera_at(
        v_raw.organization_id, v_resolved.st_id, v_raw.scanned_at
      );
    end if;
  end if;

  -- 3) Timing: chỉ đơn đi 'valid' mới được mở timing window. Kiện hoàn
  -- 'suspect' đóng ngay tại chỗ và KHÔNG đóng đơn đang mở của bàn.
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
    proof_camera_id,
    event_kind, return_kind, outbound_event_id, inspection_result, close_reason,
    work_ended_at, work_duration_seconds
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
    -- Kiện hoàn 'suspect' cũng cần work_started_at/work_ended_at để cắt được
    -- clip bằng chứng (cửa sổ clip đọc hai cột này).
    case
      when v_timing_status = 'open' then v_raw.scanned_at
      when v_status = 'return_suspect' then v_raw.scanned_at
    end,
    v_timing_status,
    null,
    case when v_status = 'unmapped_scanner' then null else v_proof_camera_id end,
    v_event_kind, v_return_kind, v_outbound_event_id, v_inspection_result, v_close_reason,
    case when v_status = 'return_suspect' then v_raw.scanned_at end,
    case when v_status = 'return_suspect' then 0 end
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

COMMIT;
