-- ============================================================================
-- Chuyển qua lại giữa hai luồng phải MƯỢT CẢ HAI CHIỀU (sự cố 24/09/2026)
--
-- Triệu chứng chủ dự án báo: "chuyển từ đóng hàng sang hoàn hàng thì chưa
-- sao nhưng chuyển ngược lại thì không được".
--
-- Ba cái kẹt tìm được, sửa cả ba ở đây:
--
-- 1. NGƯỜI GIỮ TREO. Phiên hoàn ghi danh sách `holders`, mỗi tab trình
--    duyệt một tên `module:<user>:<tab>`. Tab đóng đột ngột (sập, mất
--    điện, tắt máy) thì `sendBeacon` không kịp gửi, tên đó kẹt lại mãi.
--    Mở lại trang sinh tab mới, nên bấm "Kết thúc" chỉ gỡ tên MỚI; tên cũ
--    vẫn còn nên `release_return_capture` trả `still_held = true` và bàn
--    không bao giờ rời chế độ hoàn. Giao diện lại không có nút nào ép
--    tắt. Thêm tham số `p_force`.
--
-- 2. BÀN CÓ MỤC ĐÍCH 'return' THÌ KẸT VĨNH VIỄN. Khi nhả hết người giữ,
--    hàm gọi `set_station_mode(bàn, purpose)`; với bàn `purpose='return'`
--    thì chế độ đích TRÙNG chế độ đang chạy, `set_station_mode` thoát sớm
--    và KHÔNG đóng kỳ. Kỳ không đóng thì trigger rút không chạy, phiên
--    không bao giờ kết thúc, mà phía cloud vẫn báo agent "tắt" — lần bật
--    sau agent thấy trùng mã phiên đã kết thúc nên im lặng bỏ qua. Giờ
--    hàm tự đóng kỳ trước rồi mới đặt chế độ, nên mỗi lần bật là một kỳ
--    mới với mã mới.
--
-- 3. ĐÓNG KỲ Ở TRẠNG THÁI KHÁC 'active' THÌ KHÔNG XOÁ NGƯỜI GIỮ. Trigger
--    rút chỉ dọn `holders` khi phiên đang `active`, nên kỳ ở trạng thái
--    khác đóng lại vẫn để sót tên — đúng cái đẻ ra kẹt (1) cho lần sau.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 3. Dọn người giữ mỗi khi một kỳ hoàn đóng lại, bất kể trạng thái phiên
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drain_return_capture_on_period_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.mode <> 'return' THEN
    RETURN NEW;
  END IF;

  -- Kỳ đã đóng thì không còn ai giữ, dù phiên ở trạng thái nào.
  NEW.holders := '{}';

  IF OLD.capture_state <> 'active' THEN
    RETURN NEW;
  END IF;

  IF OLD.agent_acked_at IS NULL THEN
    -- Máy kho chưa từng nhận phiên này: không có gì để rút.
    NEW.capture_state := 'finished';
    NEW.capture_ended_at := COALESCE(NEW.capture_ended_at, NEW.ended_at);
  ELSE
    NEW.capture_state := 'draining';
    NEW.capture_ended_at := COALESCE(NEW.capture_ended_at, NEW.ended_at);
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1 + 2. Nhả phiên: thêm ép tắt, và luôn đóng kỳ trước khi đặt chế độ
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_return_capture(
  p_station_id uuid,
  p_holder text,
  p_reason text DEFAULT 'module_exit',
  p_at timestamptz DEFAULT now(),
  p_force boolean DEFAULT false
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

  -- Ép tắt: không quan tâm ai còn giữ. Dùng khi người vận hành bấm "Kết
  -- thúc" trên một bàn do nguồn khác bật — tab cũ đã chết, không ai gỡ
  -- tên nó được nữa.
  IF p_force THEN
    v_left := '{}';
  ELSE
    v_left := COALESCE(array_remove(v_period.holders, p_holder), '{}');
  END IF;

  IF array_length(v_left, 1) IS NOT NULL THEN
    UPDATE public.station_mode_periods SET holders = v_left WHERE id = v_period.id;
    capture_id := v_period.id; still_held := true;
    camera_ids := public.station_camera_ids(p_station_id);
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.station_mode_periods SET holders = v_left WHERE id = v_period.id;

  -- Đóng kỳ TẠI ĐÂY, không nhờ set_station_mode. Bàn có mục đích 'return'
  -- thì chế độ đích trùng chế độ đang chạy và set_station_mode sẽ thoát
  -- sớm, để kỳ mở mãi — chính là cái kẹt (2). Đóng ở đây cũng kích trigger
  -- rút ở trên.
  UPDATE public.station_mode_periods
  SET ended_at = p_at, ended_reason = p_reason
  WHERE id = v_period.id;

  -- Đóng nốt kiện hoàn đang mở của bàn (đợt 3).
  BEGIN
    PERFORM public.close_open_return_at_station(p_station_id, 'mode_switch', p_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'release_return_capture: khong dong duoc kien hoan dang mo (ban %): %',
      p_station_id, SQLERRM;
  END;

  -- Mở kỳ mới theo mục đích bàn. Không còn kỳ nào mở nên set_station_mode
  -- luôn tạo kỳ mới — bàn 'return' cũng có mã phiên mới, agent không còn
  -- thấy trùng mã phiên đã kết thúc.
  SELECT purpose INTO v_purpose FROM public.packing_stations WHERE id = p_station_id;
  PERFORM public.set_station_mode(
    p_station_id, COALESCE(v_purpose, 'outbound'), 'system', p_reason, p_at
  );

  capture_id := v_period.id; still_held := false;
  camera_ids := public.station_camera_ids(p_station_id);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.release_return_capture(uuid, text, text, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;

COMMIT;
