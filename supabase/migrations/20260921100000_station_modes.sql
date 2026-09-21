-- ============================================================================
-- Hàng hoàn — Đợt 2: chế độ bàn (ĐÓNG HÀNG / NHẬN HOÀN) và thẻ điều khiển
--
-- Kế hoạch: plans/active/HOAN-HANG-quay-video-don-hoan.md (mục 6, đợt 2)
-- Luồng:    plans/active/LUONG-DON-DI-DON-HOAN.md (mục 3.3)
--
-- Mỗi bàn luôn ở ĐÚNG MỘT chế độ, và chế độ luôn có đường ra tự động:
--   - quét thẻ QR điều khiển;
--   - 5 phút không thao tác → về chế độ mặc định của bàn (`purpose`);
--   - ca cuối của bàn đóng → về chế độ mặc định.
-- Không có đường nào để một bàn kẹt ở chế độ NHẬN HOÀN qua đêm rồi sáng hôm
-- sau đơn đi của nhân viên không được đếm.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Chế độ mặc định của bàn
-- ---------------------------------------------------------------------------

ALTER TABLE public.packing_stations
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'outbound';

ALTER TABLE public.packing_stations DROP CONSTRAINT IF EXISTS packing_stations_purpose_check;
ALTER TABLE public.packing_stations
  ADD CONSTRAINT packing_stations_purpose_check CHECK (purpose IN ('outbound', 'return'));

COMMENT ON COLUMN public.packing_stations.purpose IS
  'Chế độ MẶC ĐỊNH của bàn. outbound = bàn đóng hàng; return = bàn chuyên nhận hoàn (không tự về đóng hàng).';

-- ---------------------------------------------------------------------------
-- 2. Lịch sử chế độ
-- ---------------------------------------------------------------------------

-- Vì sao lưu thành từng kỳ thay vì một cột trạng thái: đợt 4 phải biết một
-- đoạn video 60 giây được ghi trong lúc bàn ở chế độ nào, để xoá segment
-- thuần hàng hoàn sau 7 ngày mà không đụng bằng chứng đơn đi.
CREATE TABLE IF NOT EXISTS public.station_mode_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  station_id uuid NOT NULL REFERENCES public.packing_stations(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('outbound', 'return')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  started_by text NOT NULL CHECK (started_by IN ('card', 'purpose', 'system', 'manual')),
  ended_reason text,
  -- Mốc "không thao tác" để tự về chế độ mặc định.
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT station_mode_periods_range_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- Bất biến: mỗi bàn tối đa MỘT kỳ đang mở.
CREATE UNIQUE INDEX IF NOT EXISTS station_mode_periods_one_open_idx
  ON public.station_mode_periods (station_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS station_mode_periods_station_time_idx
  ON public.station_mode_periods (station_id, started_at DESC);

-- Không policy = chỉ backend (service_role) đọc ghi, giống các bảng nghiệp vụ khác.
ALTER TABLE public.station_mode_periods ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_station_mode_periods_updated_at ON public.station_mode_periods;
CREATE TRIGGER trg_station_mode_periods_updated_at
  BEFORE UPDATE ON public.station_mode_periods
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Thẻ điều khiển là một loại lượt quét
-- ---------------------------------------------------------------------------

ALTER TABLE public.warehouse_scan_raw_events DROP CONSTRAINT IF EXISTS warehouse_scan_raw_events_scan_type_check;
ALTER TABLE public.warehouse_scan_raw_events
  ADD CONSTRAINT warehouse_scan_raw_events_scan_type_check
    CHECK (scan_type IN ('staff_qr', 'waybill', 'control'));

-- ---------------------------------------------------------------------------
-- 4. Đọc và đổi chế độ
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.station_current_mode(p_station_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Chưa có kỳ nào (bàn cũ, hoặc vừa tạo) thì chế độ là mặc định của bàn.
  SELECT COALESCE(
    (SELECT smp.mode FROM public.station_mode_periods smp
      WHERE smp.station_id = p_station_id AND smp.ended_at IS NULL LIMIT 1),
    (SELECT ps.purpose FROM public.packing_stations ps WHERE ps.id = p_station_id)
  );
$$;

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
    UPDATE public.station_mode_periods
      SET last_activity_at = p_at
      WHERE id = v_open_id;
    RETURN p_mode;
  END IF;

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

-- Mọi lượt quét ở bàn đều gia hạn mốc "còn đang làm việc".
CREATE OR REPLACE FUNCTION public.touch_station_mode_activity(
  p_station_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.station_mode_periods
    SET last_activity_at = GREATEST(last_activity_at, p_at)
    WHERE station_id = p_station_id AND ended_at IS NULL;
$$;

-- ---------------------------------------------------------------------------
-- 5. Lối ra tự động 1: 5 phút không thao tác
-- ---------------------------------------------------------------------------

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
      -- Bàn CHUYÊN hoàn không bao giờ tự về đóng hàng.
      AND ps.purpose = 'outbound'
      AND ps.organization_id = p_organization_id
  LOOP
    v_idle := COALESCE(
      (public.resolve_packing_timing(v_row.warehouse_id) ->> 'return_idle_revert_seconds')::int,
      300
    );
    CONTINUE WHEN v_row.last_activity_at > p_now - make_interval(secs => v_idle);

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
-- 6. Lối ra tự động 2: ca cuối của bàn đóng
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
      SELECT purpose INTO v_purpose FROM public.packing_stations WHERE id = NEW.station_id;
      PERFORM public.set_station_mode(
        NEW.station_id, v_purpose, 'system', 'shift_closed', COALESCE(NEW.ended_at, now())
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Đóng ca là việc của nhân viên; không được chặn vì phần chế độ bàn hỏng.
    RAISE WARNING 'revert_station_mode_on_shift_close (station %): %', NEW.station_id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS staff_work_sessions_revert_station_mode ON public.staff_work_sessions;
CREATE TRIGGER staff_work_sessions_revert_station_mode
AFTER INSERT OR UPDATE OF status ON public.staff_work_sessions
FOR EACH ROW
EXECUTE FUNCTION public.revert_station_mode_on_shift_close();

-- ---------------------------------------------------------------------------
-- 7. Đổi chế độ mặc định trên giao diện có tác dụng ngay
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_station_purpose_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    BEGIN
      PERFORM public.set_station_mode(NEW.id, NEW.purpose, 'purpose', 'purpose_changed');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'apply_station_purpose_change (station %): %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS packing_stations_apply_purpose ON public.packing_stations;
CREATE TRIGGER packing_stations_apply_purpose
AFTER UPDATE OF purpose ON public.packing_stations
FOR EACH ROW
EXECUTE FUNCTION public.apply_station_purpose_change();

REVOKE ALL ON FUNCTION public.set_station_mode(uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revert_idle_return_modes(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.touch_station_mode_activity(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

COMMIT;
