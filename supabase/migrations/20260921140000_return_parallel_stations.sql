-- ============================================================================
-- Hàng hoàn — Đợt 6: mọi bàn nhận hoàn song song
--
-- Kế hoạch: plans/active/HOAN-HANG-song-song-moi-ban.md
--
-- Chủ dự án yêu cầu (21/09/2026): tất cả các bàn đều xử lý hoàn hàng cùng
-- một lúc được, song song như luồng đóng hàng.
--
-- Phần lớn đã song song sẵn — mọi thứ khoá theo TỪNG BÀN (mỗi bàn một kỳ
-- chế độ mở, mỗi bàn một kiện đang mở), nên hai bàn khác nhau không bao giờ
-- tranh nhau. Migration này chỉ vá chỗ va nhau TRONG CÙNG MỘT BÀN, thứ trở
-- nên dễ gặp hơn khi cả kho cùng nhận hoàn:
--
--   Thẻ QR và nút trên giao diện bật cùng một bàn đúng cùng lúc. Hai giao
--   dịch cùng thấy kỳ ĐÓNG HÀNG đang mở, cùng đóng nó, cùng chèn kỳ NHẬN
--   HOÀN mới → giao dịch sau vấp chỉ mục "mỗi bàn một kỳ mở" và báo lỗi.
--
-- Cách vá: khoá tư vấn theo bàn ở đầu hai hàm mở/nhả phiên. Khoá theo BÀN,
-- không theo tổ chức — khoá theo tổ chức là đúng thứ biến các bàn thành
-- xếp hàng tuần tự, ngược hẳn yêu cầu.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.lock_station_mode(p_station_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  -- Khoá giữ tới hết giao dịch. Cùng một khoá cho mọi đường đổi chế độ của
  -- MỘT bàn; bàn khác có khoá khác nên không chờ nhau.
  SELECT pg_advisory_xact_lock(hashtextextended('station_mode:' || p_station_id::text, 0));
$$;

COMMENT ON FUNCTION public.lock_station_mode(uuid) IS
  'Khoá tuần tự hoá việc đổi chế độ / mở-nhả phiên hoàn của MỘT bàn. Bàn khác không bị chặn.';

-- ---------------------------------------------------------------------------
-- Mở phiên: y như đợt 5, thêm khoá theo bàn ở đầu.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.open_return_capture(
  p_station_id uuid,
  p_holder text,
  p_at timestamptz DEFAULT now()
)
RETURNS TABLE(capture_id uuid, camera_ids uuid[], already_open boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.station_mode_periods%rowtype;
  v_was_active boolean;
BEGIN
  IF p_holder IS NULL OR btrim(p_holder) = '' THEN
    RAISE EXCEPTION 'holder_required' USING errcode = 'P0001';
  END IF;

  PERFORM public.lock_station_mode(p_station_id);

  -- Dùng lại đường đổi chế độ có sẵn: nó đóng đơn đi đang mở, ghi lịch sử
  -- và giữ bất biến "mỗi bàn một kỳ mở".
  PERFORM public.set_station_mode(p_station_id, 'return', 'module', 'module_open', p_at);

  SELECT * INTO v_period
  FROM public.station_mode_periods
  WHERE station_id = p_station_id AND ended_at IS NULL
  LIMIT 1;

  IF v_period.id IS NULL OR v_period.mode <> 'return' THEN
    RAISE EXCEPTION 'return_period_not_open: %', p_station_id USING errcode = 'P0002';
  END IF;

  v_was_active := v_period.capture_state = 'active';

  UPDATE public.station_mode_periods
    SET holders = CASE WHEN p_holder = ANY(holders) THEN holders ELSE holders || p_holder END,
        capture_state = 'active',
        last_activity_at = p_at,
        last_heartbeat_at = CASE WHEN p_holder LIKE 'module:%' THEN p_at ELSE last_heartbeat_at END
    WHERE id = v_period.id;

  capture_id := v_period.id;
  camera_ids := public.station_camera_ids(p_station_id);
  already_open := v_was_active;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Nhả phiên: y như đợt 5, thêm khoá theo bàn ở đầu.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.release_return_capture(
  p_station_id uuid,
  p_holder text,
  p_reason text DEFAULT 'module_exit',
  p_at timestamptz DEFAULT now()
)
RETURNS TABLE(capture_id uuid, still_held boolean, camera_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.station_mode_periods%rowtype;
  v_left text[];
  v_purpose text;
BEGIN
  PERFORM public.lock_station_mode(p_station_id);

  SELECT * INTO v_period
  FROM public.station_mode_periods
  WHERE station_id = p_station_id AND ended_at IS NULL AND mode = 'return'
  LIMIT 1;

  IF v_period.id IS NULL THEN
    capture_id := NULL; still_held := false; camera_ids := '{}';
    RETURN NEXT;
    RETURN;
  END IF;

  v_left := array_remove(v_period.holders, p_holder);

  IF array_length(v_left, 1) IS NOT NULL THEN
    -- Còn người khác đang giữ (tab khác, hoặc thẻ QR): không cắt ngang.
    UPDATE public.station_mode_periods SET holders = v_left WHERE id = v_period.id;
    capture_id := v_period.id; still_held := true;
    camera_ids := public.station_camera_ids(p_station_id);
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.station_mode_periods SET holders = v_left WHERE id = v_period.id;

  -- Hết người giữ: bàn về chế độ mặc định. Đường này cũng đóng kiện hoàn
  -- đang mở (đợt 3) và trigger đợt 5 chuyển phiên sang 'draining'.
  SELECT purpose INTO v_purpose FROM public.packing_stations WHERE id = p_station_id;
  PERFORM public.set_station_mode(
    p_station_id, COALESCE(v_purpose, 'outbound'), 'system', p_reason, p_at
  );

  capture_id := v_period.id; still_held := false;
  camera_ids := public.station_camera_ids(p_station_id);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_station_mode(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
