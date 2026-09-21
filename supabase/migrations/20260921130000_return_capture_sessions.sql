-- ============================================================================
-- Hàng hoàn — Đợt 5: phiên ghi hoàn theo tín hiệu module
--
-- Kế hoạch: plans/active/HOAN-HANG-phien-ghi-theo-module.md
--
-- Camera của bàn vẫn ghi liên tục cho luồng đóng hàng. Cái mà tín hiệu
-- module bật/tắt là QUYỀN SỞ HỮU: đoạn video nào thuộc về phiên hoàn.
-- Không có tín hiệu → không segment nào mang nhãn hoàn → không có gì bị
-- rút hạn lưu, không có gì bị coi là video hoàn.
--
-- Phiên ghi hoàn CHÍNH LÀ kỳ chế độ NHẬN HOÀN của bàn (bảng
-- `station_mode_periods` từ đợt 2). Không thêm bảng mới: hai vòng đời
-- song song sớm muộn cũng lệch nhau, và lệch ở đây nghĩa là video bằng
-- chứng bị xoá sớm.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Kỳ chế độ mang thêm trạng thái phiên ghi
-- ---------------------------------------------------------------------------

ALTER TABLE public.station_mode_periods
  ADD COLUMN IF NOT EXISTS holders text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS capture_state text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS capture_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_acked_at timestamptz;

ALTER TABLE public.station_mode_periods DROP CONSTRAINT IF EXISTS station_mode_periods_capture_state_check;
ALTER TABLE public.station_mode_periods
  ADD CONSTRAINT station_mode_periods_capture_state_check
    CHECK (capture_state IN ('none', 'active', 'draining', 'finished', 'abandoned'));

COMMENT ON COLUMN public.station_mode_periods.holders IS
  'Ai đang giữ phiên ghi hoàn: ''card'' (thẻ QR) hoặc ''module:<user_id>'' (một người mở trang Hàng hoàn). Rỗng = không ai giữ.';
COMMENT ON COLUMN public.station_mode_periods.capture_state IS
  'none = kỳ đóng hàng. active = đang thuộc phiên. draining = người đã thoát, chờ agent lưu nốt segment cuối. finished = agent đã báo xong. abandoned = agent im quá lâu.';
COMMENT ON COLUMN public.station_mode_periods.capture_ended_at IS
  'Mốc kết thúc SEGMENT CUỐI do agent báo. Khác ended_at (lúc người thoát) đúng bằng phần đuôi của đoạn video đang ghi dở.';
COMMENT ON COLUMN public.station_mode_periods.agent_acked_at IS
  'Lúc agent xác nhận đã nhận tín hiệu. NULL = agent chưa biết gì, nên không có segment nào được gán nhãn.';

-- Mở phiên từ giao diện là một nguồn mới, ngang hàng với thẻ QR.
ALTER TABLE public.station_mode_periods DROP CONSTRAINT IF EXISTS station_mode_periods_started_by_check;
ALTER TABLE public.station_mode_periods
  ADD CONSTRAINT station_mode_periods_started_by_check
    CHECK (started_by IN ('card', 'purpose', 'system', 'manual', 'module'));

-- Quét dọn tìm theo hai trục này: phiên đang cần nhịp, và phiên đang rút.
CREATE INDEX IF NOT EXISTS station_mode_periods_capture_idx
  ON public.station_mode_periods (organization_id, capture_state)
  WHERE capture_state IN ('active', 'draining');

-- ---------------------------------------------------------------------------
-- 2. Segment mang nhãn phiên hoàn
-- ---------------------------------------------------------------------------

ALTER TABLE public.camera_recording_files
  ADD COLUMN IF NOT EXISTS return_capture_id uuid REFERENCES public.station_mode_periods(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.camera_recording_files.return_capture_id IS
  'Phiên ghi hoàn mà đoạn video này thuộc về. Do AGENT gán lúc báo segment, không suy ra từ thời gian — không có tín hiệu thì không có nhãn.';

CREATE INDEX IF NOT EXISTS camera_recording_files_return_capture_idx
  ON public.camera_recording_files (return_capture_id)
  WHERE return_capture_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Mọi đường đóng kỳ đều phải chuyển phiên sang rút
--
-- Dùng trigger chứ không sửa từng hàm: kỳ NHẬN HOÀN bị đóng từ sáu chỗ
-- khác nhau (thẻ ĐÓNG HÀNG, quét đổi chế độ, tự về sau 5 phút, đóng ca,
-- đổi mục đích bàn, nhả holder). Sửa tay sáu chỗ thì chỗ thứ bảy thêm sau
-- này sẽ quên, và quên ở đây nghĩa là agent gán nhãn mãi không dừng.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drain_return_capture_on_period_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.mode <> 'return' OR OLD.capture_state <> 'active' THEN
    RETURN NEW;
  END IF;

  NEW.holders := '{}';
  IF OLD.agent_acked_at IS NULL THEN
    -- Agent chưa từng biết phiên này nên chẳng có segment nào mang nhãn:
    -- không có gì để rút, đóng luôn.
    NEW.capture_state := 'finished';
    NEW.capture_ended_at := NEW.ended_at;
  ELSE
    NEW.capture_state := 'draining';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS station_mode_periods_drain_capture ON public.station_mode_periods;
CREATE TRIGGER station_mode_periods_drain_capture
  BEFORE UPDATE ON public.station_mode_periods
  FOR EACH ROW EXECUTE FUNCTION public.drain_return_capture_on_period_close();

-- ---------------------------------------------------------------------------
-- 4. Camera của một bàn (để gửi xuống agent)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.station_camera_ids(p_station_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(DISTINCT (sd.config_json->>'camera_id')::uuid), '{}')
  FROM public.station_device_assignments sda
  JOIN public.station_devices sd ON sd.id = sda.device_id
  WHERE sda.station_id = p_station_id
    AND sda.unassigned_at IS NULL
    AND sd.device_type = 'camera'
    AND sd.config_json->>'camera_id' IS NOT NULL;
$$;

-- ---------------------------------------------------------------------------
-- 5. Mở / gia hạn / nhả phiên
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

COMMENT ON FUNCTION public.open_return_capture(uuid, text, timestamptz) IS
  'Mở (hoặc tham gia) phiên ghi hoàn của một bàn. Trả về id phiên và danh sách camera để gửi tín hiệu xuống agent.';

CREATE OR REPLACE FUNCTION public.touch_return_capture(
  p_station_id uuid,
  p_holder text,
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
  UPDATE public.station_mode_periods
    SET last_heartbeat_at = p_at,
        last_activity_at = p_at
    WHERE station_id = p_station_id
      AND ended_at IS NULL
      AND capture_state = 'active'
      AND p_holder = ANY(holders)
    RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.touch_return_capture(uuid, text, timestamptz) IS
  'Nhịp 30 giây của giao diện. Trả NULL nghĩa là phiên đã đóng ở nơi khác — giao diện phải mở lại chứ không gia hạn ngầm.';

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
  -- đang mở (đợt 3) và trigger ở mục 3 chuyển phiên sang 'draining'.
  SELECT purpose INTO v_purpose FROM public.packing_stations WHERE id = p_station_id;
  PERFORM public.set_station_mode(
    p_station_id, COALESCE(v_purpose, 'outbound'), 'system', p_reason, p_at
  );

  capture_id := v_period.id; still_held := false;
  camera_ids := public.station_camera_ids(p_station_id);
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.release_return_capture(uuid, text, text, timestamptz) IS
  'Nhả một nguồn giữ phiên. Hết nguồn thì bàn về chế độ mặc định và phiên chuyển sang chờ agent lưu nốt segment cuối.';

-- ---------------------------------------------------------------------------
-- 6. Agent xác nhận và báo xong
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ack_return_capture(
  p_capture_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE public.station_mode_periods
    SET agent_acked_at = COALESCE(agent_acked_at, p_at)
    WHERE id = p_capture_id AND mode = 'return'
    RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_return_capture(
  p_capture_id uuid,
  p_last_segment_ended_at timestamptz,
  p_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE public.station_mode_periods
    SET capture_state = 'finished',
        capture_ended_at = GREATEST(
          COALESCE(p_last_segment_ended_at, ended_at, p_at),
          COALESCE(ended_at, started_at)
        )
    WHERE id = p_capture_id
      AND mode = 'return'
      AND capture_state IN ('draining', 'active', 'abandoned')
    RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;

COMMENT ON FUNCTION public.finish_return_capture(uuid, timestamptz, timestamptz) IS
  'Agent báo đã lưu xong đoạn video cuối của phiên. capture_ended_at không bao giờ sớm hơn lúc người thoát.';

-- ---------------------------------------------------------------------------
-- 7. Lối ra tự động
--
-- Hai lối, hai lý do khác nhau:
--   * Mất nhịp 2 phút: trình duyệt sập hoặc mất mạng. Nhả holder module.
--   * Agent im 15 phút sau khi rút: máy kho tắt giữa chừng. Đánh dấu bỏ
--     rơi để phiên không treo mãi — nhưng KHÔNG tự gán nhãn thay agent.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_return_captures(
  p_organization_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row record;
  v_holder text;
  v_count integer := 0;
  v_abandoned integer := 0;
BEGIN
  -- (a) Giao diện mất nhịp quá 2 phút.
  FOR v_row IN
    SELECT id, station_id, holders
    FROM public.station_mode_periods
    WHERE organization_id = p_organization_id
      AND ended_at IS NULL
      AND capture_state = 'active'
      AND last_heartbeat_at IS NOT NULL
      AND last_heartbeat_at < p_now - interval '2 minutes'
  LOOP
    FOREACH v_holder IN ARRAY v_row.holders LOOP
      CONTINUE WHEN v_holder NOT LIKE 'module:%';
      PERFORM public.release_return_capture(
        v_row.station_id, v_holder, 'heartbeat_timeout', p_now
      );
      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  -- (b) Agent im quá lâu sau khi phiên đã rút.
  UPDATE public.station_mode_periods
    SET capture_state = 'abandoned',
        capture_ended_at = COALESCE(capture_ended_at, ended_at)
    WHERE organization_id = p_organization_id
      AND capture_state = 'draining'
      AND ended_at < p_now - interval '15 minutes';
  GET DIAGNOSTICS v_abandoned = ROW_COUNT;

  RETURN v_count + v_abandoned;
END;
$$;

REVOKE ALL ON FUNCTION public.open_return_capture(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.touch_return_capture(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_return_capture(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ack_return_capture(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_return_capture(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_return_captures(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.station_camera_ids(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Hạn lưu 7 ngày đổi nguồn: theo NHÃN của agent, không suy từ thời gian
--
-- Đợt 4 suy ra "segment thuần hàng hoàn" từ khoảng thời gian của kỳ NHẬN
-- HOÀN. Nay agent gán nhãn tận nơi nên dùng thẳng nhãn đó: chặt hơn, và
-- đúng yêu cầu "không có tín hiệu thì không thực hiện".
--
-- Hai vế an toàn của đợt 4 giữ nguyên:
--   (b) không giao cửa sổ video của bất kỳ ĐƠN ĐI nào dùng camera đó;
--   (c) camera chỉ phục vụ đúng một bàn trong khoảng thời gian của segment.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.classify_return_segments(
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
  WITH candidate AS (
    SELECT f.id, f.camera_id, f.started_at, f.ended_at
    FROM public.camera_recording_files f
    WHERE f.organization_id = p_organization_id
      AND f.retention_class = 'default'
      -- Nhãn của agent là điều kiện bắt buộc đầu tiên.
      AND f.return_capture_id IS NOT NULL
      AND f.started_at IS NOT NULL
      AND f.ended_at IS NOT NULL
      -- Segment phải đóng hẳn: file đang ghi thì chưa biết nó chứa gì.
      AND f.ended_at < p_now - interval '10 minutes'
      -- Không cần xét segment đã quá hạn chung; nó sẽ bị xoá theo đường cũ.
      AND f.started_at > p_now - interval '30 days'
  ),
  station_of AS (
    SELECT c.id, sda.station_id
    FROM candidate c
    JOIN public.station_devices sd
      ON sd.device_type = 'camera'
     AND sd.config_json->>'camera_id' = c.camera_id::text
    JOIN public.station_device_assignments sda
      ON sda.device_id = sd.id
     AND sda.assigned_at < c.ended_at
     AND COALESCE(sda.unassigned_at, 'infinity'::timestamptz) > c.started_at
  ),
  -- (c) Chỉ đúng một bàn trong khoảng đó.
  single_station AS (
    -- Postgres không có min(uuid); ép về text để lấy đại diện, đằng nào
    -- HAVING cũng chỉ giữ nhóm có đúng một bàn.
    SELECT id, (min(station_id::text))::uuid AS station_id
    FROM station_of
    GROUP BY id
    HAVING count(DISTINCT station_id) = 1
  ),
  -- (b) Không giao với cửa sổ video của bất kỳ đơn đi nào dùng camera này.
  safe AS (
    SELECT s.id
    FROM single_station s
    JOIN candidate c ON c.id = s.id
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.packing_events pe
      WHERE pe.organization_id = p_organization_id
        AND pe.event_kind = 'outbound'
        AND (pe.proof_camera_id = c.camera_id OR pe.proof_qr_camera_id = c.camera_id)
        -- Nới hai đầu 60 giây cho pre-roll / post-roll của clip.
        AND (COALESCE(pe.work_started_at, pe.scanned_at) - interval '60 seconds') < c.ended_at
        AND (COALESCE(pe.work_ended_at, p_now) + interval '60 seconds') > c.started_at
    )
  )
  UPDATE public.camera_recording_files f
    SET retention_class = 'return_short'
    FROM safe
    WHERE f.id = safe.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.classify_return_segments(uuid, timestamptz) IS
  'Đánh dấu segment thuần hàng hoàn để agent xoá sau 7 ngày. Chỉ xét segment agent đã gán nhãn phiên hoàn; nghi ngờ thì giữ.';

COMMIT;
