-- ============================================================================
-- Hàng hoàn — Đợt 3: vòng đời kiện hoàn, thẻ kết quả, hồ sơ
--
-- Kế hoạch: plans/active/HOAN-HANG-quay-video-don-hoan.md (mục 6, đợt 3)
-- Luồng:    plans/active/LUONG-DON-DI-DON-HOAN.md (mục 5)
--
-- Tám cách một kiện hoàn kết thúc, tất cả đều ghi `close_reason`:
--   1-2. thẻ kết quả (OK / HỎNG / THIẾU / TRÁO)   → result_card
--   3.   thẻ KẾT THÚC                              → end_card
--   4.   quét kiện tiếp theo                       → next_scan
--   5.   đổi chế độ bàn                            → mode_switch
--   6.   đóng ca                                   → shift_closed
--   7.   quá 5 phút (hệ thống tự dừng)             → timeout
--   8.   lưới an toàn ở bàn đóng hàng              → suspect (đợt 1)
--
-- Mọi kết quả khác 'ok' đều sinh hồ sơ, kể cả 'unchecked'. Quên quét thẻ
-- kết quả không được phép làm mất bằng chứng.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Trạng thái timing riêng cho kiện hoàn
-- ---------------------------------------------------------------------------

-- Kiện hoàn mở cửa sổ timing để màn hình bàn đếm ngược, nhưng thời lượng của
-- nó KHÔNG phải năng suất đóng gói. Dùng giá trị riêng để không lẫn vào các
-- phép tính thời lượng của đơn đi.
ALTER TABLE public.packing_events DROP CONSTRAINT IF EXISTS packing_events_timing_status_check;
ALTER TABLE public.packing_events
  ADD CONSTRAINT packing_events_timing_status_check
    CHECK (timing_status IN (
      'open', 'finalized_by_next_scan', 'finalized_by_checkout', 'capped_timeout',
      'default_estimated', 'not_applicable', 'finalized_by_mode_switch', 'return_closed'
    ));

-- ---------------------------------------------------------------------------
-- 2. Hồ sơ kiện hoàn
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.return_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  packing_event_id uuid NOT NULL UNIQUE REFERENCES public.packing_events(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'submitted', 'dismissed', 'expired')),
  deadline_at timestamptz NOT NULL,
  -- Mã khiếu nại bên sàn, người dùng tự ghi. KHÔNG có số tiền: hệ thống
  -- không xử lý tiền bạc (chốt với chủ dự án 18/09/2026).
  platform_claim_ref text,
  note text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS return_claims_open_idx
  ON public.return_claims (organization_id, deadline_at)
  WHERE status = 'open';

ALTER TABLE public.return_claims ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_return_claims_updated_at ON public.return_claims;
CREATE TRIGGER trg_return_claims_updated_at
  BEFORE UPDATE ON public.return_claims
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Hồ sơ mở ra ngay khi kiện đóng với kết quả khác 'ok'. Làm bằng trigger để
-- CẢ TÁM đường đóng kiện đều tạo hồ sơ — kể cả đường chạy hoàn toàn trong
-- database (đóng ca, đổi chế độ).
CREATE OR REPLACE FUNCTION public.open_return_claim_if_needed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hours integer;
BEGIN
  IF NEW.event_kind <> 'return' THEN RETURN NEW; END IF;
  IF NEW.timing_status = 'open' THEN RETURN NEW; END IF;
  IF NEW.inspection_result IS NULL OR NEW.inspection_result = 'ok' THEN RETURN NEW; END IF;

  BEGIN
    v_hours := COALESCE(
      (public.resolve_packing_timing(NEW.warehouse_id) ->> 'return_claim_hours')::int,
      168
    );
    INSERT INTO public.return_claims (organization_id, packing_event_id, deadline_at)
    VALUES (NEW.organization_id, NEW.id, NEW.scanned_at + make_interval(hours => v_hours))
    ON CONFLICT (packing_event_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Mất hồ sơ là mất việc nhắc hạn, nhưng chặn lượt quét thì nhân viên
    -- không làm việc được. Ghi cảnh báo, cho đi tiếp.
    RAISE WARNING 'open_return_claim_if_needed (event %): %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS packing_events_open_return_claim ON public.packing_events;
CREATE TRIGGER packing_events_open_return_claim
AFTER INSERT OR UPDATE OF timing_status, inspection_result ON public.packing_events
FOR EACH ROW
EXECUTE FUNCTION public.open_return_claim_if_needed();

-- Lối ra tự động của hồ sơ: quá hạn thì tự chuyển 'expired'.
CREATE OR REPLACE FUNCTION public.expire_return_claims(
  p_organization_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.return_claims
    SET status = 'expired'
    WHERE organization_id = p_organization_id
      AND status = 'open'
      AND deadline_at <= p_now;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Đóng một kiện hoàn
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.close_return_event(
  p_event_id uuid,
  p_result text,
  p_close_reason text,
  p_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_started timestamptz;
BEGIN
  SELECT work_started_at INTO v_started
  FROM public.packing_events
  WHERE id = p_event_id AND event_kind = 'return' AND timing_status = 'open';

  IF NOT FOUND THEN
    RETURN false;  -- đã đóng bởi đường khác; idempotent
  END IF;

  UPDATE public.packing_events
    SET inspection_result = COALESCE(p_result, 'unchecked'),
        close_reason = p_close_reason,
        timing_status = 'return_closed',
        work_ended_at = p_at,
        work_duration_seconds = GREATEST(0, extract(epoch FROM (p_at - COALESCE(v_started, p_at)))::int)
    WHERE id = p_event_id;

  RETURN true;
END;
$$;

-- Đóng kiện hoàn đang mở của một bàn (dùng cho đổi chế độ, đóng ca).
CREATE OR REPLACE FUNCTION public.close_open_return_at_station(
  p_station_id uuid,
  p_close_reason text,
  p_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
  FROM public.packing_events
  WHERE station_id = p_station_id AND event_kind = 'return' AND timing_status = 'open'
  LIMIT 1;

  IF v_id IS NULL THEN RETURN NULL; END IF;
  PERFORM public.close_return_event(v_id, 'unchecked', p_close_reason, p_at);
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Quét mã ở chế độ NHẬN HOÀN
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.process_return_scan(p_raw_event_id uuid)
RETURNS TABLE(
  status text,
  packing_event_id uuid,
  waybill_code text,
  station_id uuid,
  return_kind text,
  outbound_event_id uuid,
  outbound_scanned_at timestamptz,
  closed_previous_id uuid
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
declare
  v_raw public.warehouse_scan_raw_events%rowtype;
  v_existing public.packing_events%rowtype;
  v_waybill text;
  v_resolved record;
  v_session public.staff_work_sessions%rowtype;
  v_session_id uuid;
  v_staff_id uuid;
  v_assignment text := 'none';
  v_status text;
  v_return_kind text;
  v_outbound_id uuid;
  v_outbound_at timestamptz;
  v_prev_return_id uuid;
  v_closed_prev_id uuid;
  v_suspect_id uuid;
  v_new_id uuid;
  v_proof_camera_id uuid;
  v_timing_cfg jsonb;
  v_lookback_days integer;
begin
  -- Idempotent theo raw event, giống đường đơn đi.
  select * into v_existing from public.packing_events pe where pe.raw_event_id = p_raw_event_id;
  if found then
    return query
      select v_existing.status, v_existing.id, v_existing.waybill_code, v_existing.station_id,
             v_existing.return_kind, v_existing.outbound_event_id,
             (select pe2.scanned_at from public.packing_events pe2 where pe2.id = v_existing.outbound_event_id),
             null::uuid;
    return;
  end if;

  select * into v_raw from public.warehouse_scan_raw_events where id = p_raw_event_id;
  if not found then
    raise exception 'raw_event_not_found: %', p_raw_event_id using errcode = 'P0002';
  end if;
  if v_raw.scan_type <> 'waybill' then
    raise exception 'raw_event_not_waybill: scan_type=%', v_raw.scan_type using errcode = 'P0001';
  end if;

  v_waybill := upper(trim(v_raw.raw_value));

  select r.station_id as st_id, r.warehouse_id as wh_id
    into v_resolved
  from public.resolve_scanner_at(v_raw.organization_id, v_raw.scanner_device_code, v_raw.scanned_at) r;

  if v_waybill = '' then
    v_status := 'invalid_code';
  elsif v_resolved.st_id is null then
    v_status := 'unmapped_scanner';
  else
    select * into v_session
    from public.staff_work_sessions sws
    where sws.station_id = v_resolved.st_id and sws.status = 'active'
    limit 1;

    if found then
      v_assignment := 'active_session';
      v_session_id := v_session.id;
      v_staff_id := v_session.staff_id;
    end if;

    if v_session_id is null then
      -- Không có ca = không có ghi hình = không có bằng chứng. Ghi nhận
      -- lượt quét nhưng không mở kiện.
      v_status := 'no_active_session';
    else
      v_timing_cfg := public.resolve_packing_timing(v_resolved.wh_id);
      v_lookback_days := coalesce((v_timing_cfg ->> 'return_lookback_days')::int, 60);

      -- Đã ghi hoàn kiện này rồi? (không tính lượt 'suspect' của lưới an toàn)
      select pe.id into v_prev_return_id
      from public.packing_events pe
      where pe.organization_id = v_raw.organization_id
        and pe.waybill_code = v_waybill
        and pe.event_kind = 'return'
        and pe.return_kind in ('rts', 'customer_return')
        and pe.scanned_at >= v_raw.scanned_at - make_interval(days => v_lookback_days)
      order by pe.scanned_at desc
      limit 1;

      if v_prev_return_id is not null then
        -- Kiện này đã ghi hoàn rồi: KHÔNG mở kiện mới, và cũng KHÔNG đụng
        -- vào kiện đang mở. Quét trùng thường là nhân viên quét lại đúng
        -- kiện đang kiểm dở — đóng nó ở đây là cắt ngang việc đang làm.
        v_status := 'duplicated_return';
      else
        v_status := 'valid';

        -- Mở kiện mới thì kiện đang mở trước đó phải đóng lại.
        v_closed_prev_id := public.close_open_return_at_station(
          v_resolved.st_id, 'next_scan', v_raw.scanned_at
        );

        -- Lưới an toàn: còn sót một ĐƠN ĐI đang mở ở bàn (đổi chế độ bằng
        -- đường không đi qua set_station_mode, hoặc dữ liệu cũ). Bàn chỉ
        -- được có một lượt mở — đóng đơn đi, ghi đúng lý do đổi chế độ.
        update public.packing_events
          set timing_status = 'finalized_by_mode_switch',
              work_ended_at = v_raw.scanned_at,
              work_duration_seconds = greatest(0, extract(epoch from (v_raw.scanned_at - coalesce(work_started_at, v_raw.scanned_at)))::int)
          where station_id = v_resolved.st_id
            and event_kind = 'outbound'
            and timing_status = 'open';
      end if;

      -- Đơn đi cùng mã → kiện hoàn do giao thất bại, và nối được hai video.
      select pe.id, pe.scanned_at into v_outbound_id, v_outbound_at
      from public.packing_events pe
      where pe.organization_id = v_raw.organization_id
        and pe.waybill_code = v_waybill
        and pe.event_kind = 'outbound'
        and pe.status = 'valid'
        and pe.scanned_at >= v_raw.scanned_at - make_interval(days => v_lookback_days)
      order by pe.scanned_at desc
      limit 1;

      v_return_kind := case when v_outbound_id is not null then 'rts' else 'customer_return' end;

      -- Lưới an toàn đã bắt mã này ở bàn đóng hàng: hồ sơ đó không còn cần,
      -- vì giờ kiện được mở đúng chỗ và sẽ có hồ sơ riêng nếu có vấn đề.
      select pe.id into v_suspect_id
      from public.packing_events pe
      where pe.organization_id = v_raw.organization_id
        and pe.waybill_code = v_waybill
        and pe.event_kind = 'return'
        and pe.return_kind = 'suspect'
        and pe.scanned_at >= v_raw.scanned_at - make_interval(days => v_lookback_days)
      order by pe.scanned_at desc
      limit 1;

      if v_suspect_id is not null then
        update public.return_claims
          set status = 'dismissed',
              note = concat_ws(' · ', note, 'Kiện đã được mở đúng ở bàn nhận hoàn')
          where packing_event_id = v_suspect_id and status = 'open';
      end if;

      v_proof_camera_id := public.resolve_station_camera_at(
        v_raw.organization_id, v_resolved.st_id, v_raw.scanned_at
      );
    end if;
  end if;

  insert into public.packing_events (
    organization_id, raw_event_id, waybill_code,
    warehouse_id, station_id, scanner_device_code,
    staff_id, work_session_id, scanned_at,
    status, assignment_method,
    work_started_at, timing_status, proof_camera_id,
    event_kind, return_kind, outbound_event_id, inspection_result, close_reason
  )
  values (
    v_raw.organization_id, p_raw_event_id, coalesce(v_waybill, ''),
    case when v_status in ('unmapped_scanner', 'invalid_code') then null else v_resolved.wh_id end,
    case when v_status in ('unmapped_scanner', 'invalid_code') then null else v_resolved.st_id end,
    v_raw.scanner_device_code,
    case when v_assignment <> 'none' then v_staff_id end,
    case when v_assignment <> 'none' then v_session_id end,
    v_raw.scanned_at,
    v_status, v_assignment,
    case when v_status = 'valid' then v_raw.scanned_at end,
    case when v_status = 'valid' then 'open' else 'not_applicable' end,
    case when v_status in ('unmapped_scanner', 'invalid_code') then null else v_proof_camera_id end,
    'return',
    case when v_status in ('valid', 'duplicated_return') then v_return_kind end,
    case when v_status in ('valid', 'duplicated_return') then v_outbound_id end,
    null, null
  )
  returning id into v_new_id;

  return query
    select v_status, v_new_id, v_waybill,
           case when v_status in ('unmapped_scanner', 'invalid_code') then null else v_resolved.st_id end,
           case when v_status in ('valid', 'duplicated_return') then v_return_kind end,
           case when v_status in ('valid', 'duplicated_return') then v_outbound_id end,
           case when v_status in ('valid', 'duplicated_return') then v_outbound_at end,
           v_closed_prev_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Đổi chế độ bàn cũng là một cách đóng lượt đang mở
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_station_mode(
  p_station_id uuid,
  p_mode text,
  p_started_by text,
  p_reason text DEFAULT NULL,
  p_at timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid;
  v_open_id uuid;
  v_open_mode text;
  v_open_event public.packing_events%rowtype;
  v_duration integer;
BEGIN
  IF p_mode NOT IN ('outbound', 'return') THEN
    RAISE EXCEPTION 'invalid_mode: %', p_mode USING errcode = 'P0001';
  END IF;

  SELECT organization_id INTO v_org FROM public.packing_stations WHERE id = p_station_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'station_not_found: %', p_station_id USING errcode = 'P0002';
  END IF;

  SELECT id, mode INTO v_open_id, v_open_mode
  FROM public.station_mode_periods
  WHERE station_id = p_station_id AND ended_at IS NULL
  LIMIT 1;

  -- Quét lại đúng thẻ đang dùng: không tạo kỳ mới, chỉ gia hạn mốc thao tác.
  IF v_open_id IS NOT NULL AND v_open_mode = p_mode THEN
    UPDATE public.station_mode_periods SET last_activity_at = p_at WHERE id = v_open_id;
    RETURN p_mode;
  END IF;

  -- Đổi chế độ thì lượt đang mở của chế độ cũ phải đóng lại — không để một
  -- đơn đi treo trong lúc bàn đã chuyển sang nhận hoàn, và ngược lại.
  BEGIN
    IF p_mode = 'return' THEN
      SELECT * INTO v_open_event
      FROM public.packing_events
      WHERE station_id = p_station_id AND event_kind = 'outbound' AND timing_status = 'open'
      LIMIT 1;
      IF FOUND THEN
        v_duration := GREATEST(0, extract(epoch FROM (p_at - COALESCE(v_open_event.work_started_at, p_at)))::int);
        UPDATE public.packing_events
          SET timing_status = 'finalized_by_mode_switch',
              work_ended_at = p_at,
              work_duration_seconds = v_duration
          WHERE id = v_open_event.id;
      END IF;
    ELSE
      PERFORM public.close_open_return_at_station(p_station_id, 'mode_switch', p_at);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'set_station_mode dong luot dang mo (station %): %', p_station_id, SQLERRM;
  END;

  IF v_open_id IS NOT NULL THEN
    UPDATE public.station_mode_periods
      SET ended_at = p_at, ended_reason = COALESCE(p_reason, p_started_by)
      WHERE id = v_open_id;
  END IF;

  INSERT INTO public.station_mode_periods
    (organization_id, station_id, mode, started_by, started_at, last_activity_at)
  VALUES (v_org, p_station_id, p_mode, p_started_by, p_at, p_at);

  RETURN p_mode;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5b. Tự về chế độ đóng hàng cũng đóng kiện hoàn đang mở
-- ---------------------------------------------------------------------------

-- Bản đợt 2 chỉ đổi kỳ chế độ. Từ đợt 3 kiện hoàn có vòng đời riêng, nên
-- lối ra "5 phút không thao tác" cũng phải đóng kiện đang mở — nếu không,
-- kiện treo mãi và bàn không mở được lượt mới (mỗi bàn chỉ một lượt mở).
CREATE OR REPLACE FUNCTION public.revert_idle_return_modes(
  p_organization_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE(station_id uuid, station_code text, idle_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row record;
  v_idle integer;
BEGIN
  FOR v_row IN
    SELECT smp.id, smp.station_id, smp.last_activity_at, ps.code, ps.purpose, ps.warehouse_id
    FROM public.station_mode_periods smp
    JOIN public.packing_stations ps ON ps.id = smp.station_id
    WHERE smp.ended_at IS NULL
      AND smp.mode = 'return'
      AND ps.purpose = 'outbound'
      AND ps.organization_id = p_organization_id
  LOOP
    v_idle := COALESCE(
      (public.resolve_packing_timing(v_row.warehouse_id) ->> 'return_idle_revert_seconds')::int,
      300
    );
    CONTINUE WHEN v_row.last_activity_at > p_now - make_interval(secs => v_idle);

    PERFORM public.close_open_return_at_station(v_row.station_id, 'mode_switch', p_now);

    UPDATE public.station_mode_periods
      SET ended_at = p_now, ended_reason = 'idle_revert'
      WHERE id = v_row.id;

    INSERT INTO public.station_mode_periods
      (organization_id, station_id, mode, started_by, started_at, last_activity_at)
    VALUES (p_organization_id, v_row.station_id, v_row.purpose, 'system', p_now, p_now);

    station_id := v_row.station_id;
    station_code := v_row.code;
    idle_seconds := v_idle;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Đóng ca cũng đóng kiện hoàn đang mở
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revert_station_mode_on_shift_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_open_count integer;
  v_purpose text;
BEGIN
  IF NEW.station_id IS NULL OR NEW.status = 'active' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'active' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT count(*) INTO v_open_count
    FROM public.staff_work_sessions sws
    WHERE sws.station_id = NEW.station_id AND sws.status = 'active';

    IF v_open_count = 0 THEN
      -- Kiện hoàn đang mở: đóng với 'chưa kiểm' để vẫn có hồ sơ và video.
      PERFORM public.close_open_return_at_station(
        NEW.station_id, 'shift_closed', COALESCE(NEW.ended_at, now())
      );
      SELECT purpose INTO v_purpose FROM public.packing_stations WHERE id = NEW.station_id;
      PERFORM public.set_station_mode(
        NEW.station_id, v_purpose, 'system', 'shift_closed', COALESCE(NEW.ended_at, now())
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'revert_station_mode_on_shift_close (station %): %', NEW.station_id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Checkout chỉ chốt ĐƠN ĐI
-- ---------------------------------------------------------------------------

-- Hàm gốc chốt mọi lượt `timing_status='open'` của bàn. Sau khi có kiện hoàn,
-- nó sẽ chốt nhầm kiện hoàn thành "đơn đóng xong lúc checkout" — sai thời
-- lượng, sai loại, và kiện hoàn mất đường sinh hồ sơ đúng lý do.
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
    and pe.event_kind = 'outbound'
  limit 1;

  if not found then return; end if;

  v_cfg := public.resolve_packing_timing(v_open.warehouse_id);

  v_close_on_checkout := (v_cfg ->> 'close_last_order_on_checkout')::boolean;
  if not v_close_on_checkout then
    return;
  end if;

  v_max_order_seconds := (v_cfg ->> 'max_order_seconds')::int;
  v_cap_multiplier := (v_cfg ->> 'checkout_gap_cap_multiplier')::numeric;
  v_default_last := (v_cfg ->> 'default_last_order_seconds')::int;
  v_threshold := (v_max_order_seconds * v_cap_multiplier)::int;
  v_gap_seconds := extract(epoch from (p_closed_at - v_open.work_started_at))::int;

  if v_gap_seconds > v_threshold then
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

REVOKE ALL ON FUNCTION public.close_return_event(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_open_return_at_station(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_return_scan(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_return_claims(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

COMMIT;
