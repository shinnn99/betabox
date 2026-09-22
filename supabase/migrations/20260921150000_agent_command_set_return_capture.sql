-- ============================================================================
-- Hàng hoàn — cho phép lệnh `set_return_capture` trong hàng đợi lệnh agent
-- (kèm: ghi đúng người mở kỳ nhận hoàn)
--
-- Lỗi thật, bắt được khi chạy thử đầu-cuối trên agent 0.10.0 (21/09/2026):
--
--   [return-capture] không xếp được lệnh: new row for relation
--   "agent_commands" violates check constraint "agent_commands_type_check"
--
-- Đợt 5 thêm lệnh `set_return_capture` (tín hiệu bật/tắt phiên nhận hoàn
-- xuống agent) nhưng quên nới ràng buộc loại lệnh. Hệ quả: cloud mở phiên
-- nhận hoàn trong database nhưng agent KHÔNG BAO GIỜ biết — không đoạn video
-- nào được gán nhãn hàng hoàn. Các lần chạy thử trước chỉ gọi hàm database,
-- chưa lần nào chèn lệnh thật vào `agent_commands`, nên không lộ.
--
-- Vì sao đọc danh sách từ database thay vì chép cứng: production dựng lớp
-- 2 camera bằng file gộp riêng, danh sách loại lệnh trên đó có thể khác
-- file migration gốc. Chép cứng một danh sách thiếu là âm thầm cấm luôn
-- một loại lệnh đang chạy. Ở đây giữ NGUYÊN mọi loại đang có, chỉ thêm một.
-- Nếu trong bảng có dòng nào không hợp lệ thì ADD CONSTRAINT báo lỗi và cả
-- file tự huỷ — không để database dở dang.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_def text;
  v_types text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_def
  FROM pg_constraint c
  WHERE c.conname = 'agent_commands_type_check'
    AND c.conrelid = 'public.agent_commands'::regclass;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'khong tim thay rang buoc agent_commands_type_check — dung lai, khong doan danh sach';
  END IF;

  -- Postgres in ràng buộc theo HAI dạng tuỳ cách tạo:
  --   a) từng giá trị có nháy:  type = ANY (ARRAY['ping'::text, 'cut_clip'::text])
  --   b) một mảng literal:      type = ANY ('{ping,cut_clip}'::text[])
  -- Production (dựng bằng file gộp) đang ở dạng (b) — regex bắt 'x' không ra
  -- gì, guard bên dưới tưởng đọc thiếu và huỷ cả file. Đọc cả hai dạng.
  SELECT array_agg(DISTINCT t ORDER BY t)
    INTO v_types
  FROM (
    SELECT m[1] AS t FROM regexp_matches(v_def, '''([a-z_]+)''', 'g') AS m
    UNION
    SELECT btrim(x)
    FROM regexp_matches(v_def, '''\{([a-z_,]+)\}''', 'g') AS a,
         unnest(string_to_array(a[1], ',')) AS x
  ) s
  WHERE t <> '';

  IF v_types IS NULL OR array_length(v_types, 1) < 5 THEN
    RAISE EXCEPTION 'doc duoc qua it loai lenh tu rang buoc hien tai (%): dung lai', v_def;
  END IF;

  IF NOT ('set_return_capture' = ANY (v_types)) THEN
    v_types := array_append(v_types, 'set_return_capture'::text);
  END IF;

  ALTER TABLE public.agent_commands DROP CONSTRAINT agent_commands_type_check;
  EXECUTE format(
    'ALTER TABLE public.agent_commands ADD CONSTRAINT agent_commands_type_check CHECK (type = ANY (%L::text[]))',
    v_types
  );

  RAISE NOTICE 'agent_commands_type_check: % loai lenh', array_length(v_types, 1);
END;
$$;

-- ---------------------------------------------------------------------------
-- Kèm: kỳ NHẬN HOÀN do thẻ QR mở phải ghi started_by = 'card'
--
-- Cần đợt 6 (lock_station_mode) đã áp trước.
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
  -- Ghi đúng ai mở kỳ: thẻ QR là 'card', giao diện là 'module'. Bản đợt 5/6
  -- ghi cứng 'module' nên kỳ do thẻ mở cũng mang nhãn giao diện — sai lịch
  -- sử (bắt được khi chạy thử đầu-cuối 21/09/2026).
  PERFORM public.set_station_mode(
    p_station_id, 'return',
    CASE WHEN p_holder = 'card' THEN 'card' ELSE 'module' END,
    CASE WHEN p_holder = 'card' THEN 'card_return' ELSE 'module_open' END,
    p_at
  );

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

COMMIT;
