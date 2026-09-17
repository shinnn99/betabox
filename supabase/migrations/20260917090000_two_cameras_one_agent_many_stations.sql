-- Lớp database của nhánh 2-camera, ở dạng MỘT AGENT PHỤC VỤ NHIỀU BÀN.
--
-- Vì sao có file này thay vì áp hai migration cũ:
--   `20260914080000_two_cameras_logic_schema.sql` và
--   `20260914165000_two_cameras_shift_recording.sql` CHƯA TỪNG được áp lên
--   production (đối chiếu supabase_migrations.schema_migrations, 17/09/2026).
--   Áp nguyên hai file đó sẽ gây hại:
--
--   1. Trigger chụp camera QR trong file 080000 đọc `cameras.station_id` và
--      `cameras.is_active` — hai cột KHÔNG tồn tại. Nó là trigger
--      BEFORE INSERT trên packing_events, nên MỌI lần quét mã vận đơn sẽ
--      lỗi và không ghi được sự kiện đóng đơn nào.
--   2. Trigger ghi theo ca trong file 165000 chỉ bật ghi camera khi agent của
--      nó gắn ĐÚNG bàn đó (`wa.station_id = sda.station_id`). Chủ dự án chốt
--      dùng một agent cho mọi bàn, nên điều kiện này làm mọi bàn ngoài bàn
--      của agent không bao giờ được ghi theo ca.
--
-- File này gộp hai lớp đó, sửa cả hai lỗi, và thêm lưới an toàn: không
-- trigger nào ở đây được phép làm hỏng thao tác nghiệp vụ gốc (quét mã,
-- mở/đóng ca). Hỏng phần phụ thì ghi WARNING vào log Postgres và cho thao
-- tác gốc đi tiếp.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Cột và bảng phục vụ video ghép hai góc
-- ---------------------------------------------------------------------------

ALTER TABLE public.packing_events
  ADD COLUMN IF NOT EXISTS proof_qr_camera_id uuid
    REFERENCES public.cameras(id) ON DELETE SET NULL;

ALTER TABLE public.order_proof_clips
  ADD COLUMN IF NOT EXISTS qr_camera_id uuid REFERENCES public.cameras(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS angles_present jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS layout text,
  ADD COLUMN IF NOT EXISTS progress_percent integer
    CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS label_check jsonb;

-- Ràng buộc cũ trên production chỉ cho 'encoding'. Luồng ghép hai góc ghi
-- thêm cutting/composing/uploading — với ràng buộc cũ mọi cập nhật tiến độ
-- đó bị từ chối. Toàn bộ giá trị hiện có là NULL nên nới ra là an toàn.
ALTER TABLE public.order_proof_clips
  DROP CONSTRAINT IF EXISTS order_proof_clips_progress_state_check;
ALTER TABLE public.order_proof_clips
  ADD CONSTRAINT order_proof_clips_progress_state_check
  CHECK (progress_state IS NULL
         OR progress_state IN ('encoding', 'cutting', 'composing', 'uploading'));

CREATE TABLE IF NOT EXISTS public.order_proof_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  fail_reason text
);
CREATE INDEX IF NOT EXISTS order_proof_requests_pending_idx
  ON public.order_proof_requests (requested_at) WHERE status = 'pending';

-- File gốc KHÔNG bật RLS cho bảng này. Supabase cấp sẵn quyền trên schema
-- public cho anon/authenticated, nên bảng mới không có RLS là đọc/ghi được
-- từ trình duyệt. Không policy = mặc định chặn; chỉ backend (service_role)
-- đọc ghi, giống các bảng nghiệp vụ khác.
ALTER TABLE public.order_proof_requests ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Chụp camera QR lúc quét — viết lại cho đúng schema thật
-- ---------------------------------------------------------------------------
--
-- Lưu camera đang ở vị trí QR của bàn TẠI THỜI ĐIỂM QUÉT, để sau này dời
-- camera sang bàn khác không làm clip của đơn cũ lấy nhầm camera mới.
--
-- Tra theo phân công thật (station_device_assignments + vai trò trong
-- station_devices.config_json), KHÔNG theo cột cameras.station_id vốn không
-- tồn tại. Chụp bất kể bàn quét bằng súng hay bằng camera: camera ở vị trí
-- QR luôn là góc quay đọc mã của clip bằng chứng.
CREATE OR REPLACE FUNCTION public.capture_packing_event_qr_camera()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.proof_qr_camera_id IS NOT NULL OR NEW.station_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT c.id INTO NEW.proof_qr_camera_id
    FROM public.station_device_assignments sda
    JOIN public.station_devices sd
      ON sd.id = sda.device_id
     AND sd.organization_id = sda.organization_id
     AND sd.device_type = 'camera'
     AND sd.status <> 'archived'
     AND sd.config_json->>'role' = 'proof_qr'
    JOIN public.cameras c
      ON c.id::text = sd.config_json->>'camera_id'
     AND c.organization_id = sda.organization_id
    WHERE sda.organization_id = NEW.organization_id
      AND sda.station_id = NEW.station_id
      AND sda.unassigned_at IS NULL
    ORDER BY sda.assigned_at DESC
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    -- Mất ảnh chụp chỉ khiến clip rơi về tra theo phân công hiện tại.
    -- Chặn lần quét thì mất luôn sự kiện đóng đơn — không đánh đổi được.
    RAISE WARNING 'capture_packing_event_qr_camera: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_packing_event_qr_camera() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_packing_event_qr_camera() FROM anon;
REVOKE ALL ON FUNCTION public.capture_packing_event_qr_camera() FROM authenticated;

DROP TRIGGER IF EXISTS packing_events_capture_qr_camera ON public.packing_events;
CREATE TRIGGER packing_events_capture_qr_camera
BEFORE INSERT ON public.packing_events
FOR EACH ROW
EXECUTE FUNCTION public.capture_packing_event_qr_camera();

-- ---------------------------------------------------------------------------
-- 3. Bật/dừng ghi theo ca — một agent phục vụ nhiều bàn
-- ---------------------------------------------------------------------------
--
-- Giữ nguyên logic đã thiết kế ở 20260914165000 (ca đầu tiên mở thì bật,
-- ca cuối đóng thì hẹn dừng sau 60 giây, chống lệnh trùng, huỷ lệnh dừng
-- đang chờ khi có ca mới), với MỘT thay đổi: bỏ điều kiện agent phải gắn
-- đúng bàn. Bàn của camera đã được xác định bởi phân công
-- (sda.station_id = NEW.station_id); agent chỉ cần là agent của camera và
-- còn hoạt động.
CREATE OR REPLACE FUNCTION public.enqueue_session_recording_commands()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_open_count integer;
  v_action text;
  v_stop_at timestamptz;
  v_camera record;
  v_recording_session_id uuid;
BEGIN
  IF NEW.station_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    SELECT count(*) INTO v_open_count
    FROM public.staff_work_sessions sws
    WHERE sws.organization_id = NEW.organization_id
      AND sws.station_id = NEW.station_id
      AND sws.status = 'active';
    IF v_open_count = 1 THEN
      v_action := 'start';
    END IF;
  ELSIF TG_OP = 'UPDATE'
        AND OLD.status = 'active'
        AND NEW.status IS DISTINCT FROM 'active' THEN
    SELECT count(*) INTO v_open_count
    FROM public.staff_work_sessions sws
    WHERE sws.organization_id = NEW.organization_id
      AND sws.station_id = NEW.station_id
      AND sws.status = 'active';
    IF v_open_count = 0 THEN
      v_action := 'stop';
      v_stop_at := coalesce(NEW.ended_at, now()) + interval '60 seconds';
    END IF;
  END IF;

  IF v_action IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    FOR v_camera IN
      SELECT DISTINCT
        c.id AS camera_id,
        c.camera_code,
        c.agent_id,
        c.organization_id
      FROM public.station_device_assignments sda
      JOIN public.station_devices sd
        ON sd.id = sda.device_id
       AND sd.organization_id = sda.organization_id
       AND sd.device_type = 'camera'
       AND sd.status <> 'archived'
      JOIN public.cameras c
        ON c.id::text = sd.config_json->>'camera_id'
       AND c.organization_id = sda.organization_id
       AND c.status = 'active'
       AND c.agent_id IS NOT NULL
      JOIN public.warehouse_agents wa
        ON wa.id = c.agent_id
       AND wa.organization_id = c.organization_id
       AND wa.status = 'active'
      JOIN public.packing_stations ps
        ON ps.id = sda.station_id
       AND ps.organization_id = sda.organization_id
      WHERE sda.organization_id = NEW.organization_id
        AND sda.station_id = NEW.station_id
        AND sda.unassigned_at IS NULL
        AND sd.config_json->>'role' IN ('proof_primary', 'proof_qr')
        AND (
          v_action = 'stop'
          OR sd.config_json->>'role' = 'proof_primary'
          OR (sd.config_json->>'role' = 'proof_qr' AND ps.scan_source = 'camera')
        )
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended(v_camera.camera_id::text, 824731)
      );

      IF v_action = 'start' THEN
        -- Ca mới mở thì huỷ lệnh dừng còn đang chờ của camera này.
        UPDATE public.agent_commands
        SET status = 'done',
            completed_at = now(),
            result = jsonb_build_object('cancelled_by', 'station_shift_opened'),
            updated_at = now()
        WHERE organization_id = v_camera.organization_id
          AND agent_id = v_camera.agent_id
          AND type = 'stop_recording'
          AND status = 'pending'
          AND payload->>'camera_id' = v_camera.camera_id::text;

        SELECT crs.id INTO v_recording_session_id
        FROM public.camera_recording_sessions crs
        WHERE crs.organization_id = v_camera.organization_id
          AND crs.camera_id = v_camera.camera_id
          AND crs.status IN ('recording', 'connection_lost')
        ORDER BY crs.started_at DESC
        LIMIT 1;

        IF v_recording_session_id IS NULL THEN
          INSERT INTO public.camera_recording_sessions (
            organization_id, camera_id, status, transport, segment_seconds,
            output_dir, started_at, created_by
          ) VALUES (
            v_camera.organization_id, v_camera.camera_id, 'recording', 'tcp', 60,
            '_agent_managed/' || v_camera.camera_code, now(), NULL
          )
          RETURNING id INTO v_recording_session_id;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM public.agent_commands ac
          WHERE ac.organization_id = v_camera.organization_id
            AND ac.agent_id = v_camera.agent_id
            AND ac.type = 'start_recording'
            AND ac.status IN ('pending', 'taken')
            AND ac.payload->>'camera_id' = v_camera.camera_id::text
        ) THEN
          INSERT INTO public.agent_commands (organization_id, agent_id, type, payload)
          VALUES (
            v_camera.organization_id,
            v_camera.agent_id,
            'start_recording',
            jsonb_build_object(
              'camera_id', v_camera.camera_id::text,
              'camera_code', v_camera.camera_code,
              'session_id', v_recording_session_id::text,
              'station_id', NEW.station_id::text,
              'reason', 'station_shift_opened'
            )
          );
        END IF;
      ELSE
        SELECT crs.id INTO v_recording_session_id
        FROM public.camera_recording_sessions crs
        WHERE crs.organization_id = v_camera.organization_id
          AND crs.camera_id = v_camera.camera_id
          AND crs.status IN ('recording', 'connection_lost')
        ORDER BY crs.started_at DESC
        LIMIT 1;

        IF v_recording_session_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.agent_commands ac
          WHERE ac.organization_id = v_camera.organization_id
            AND ac.agent_id = v_camera.agent_id
            AND ac.type = 'stop_recording'
            AND ac.status IN ('pending', 'taken')
            AND ac.payload->>'camera_id' = v_camera.camera_id::text
            AND ac.payload->>'session_id' = v_recording_session_id::text
        ) THEN
          INSERT INTO public.agent_commands (organization_id, agent_id, type, payload)
          VALUES (
            v_camera.organization_id,
            v_camera.agent_id,
            'stop_recording',
            jsonb_build_object(
              'camera_id', v_camera.camera_id::text,
              'camera_code', v_camera.camera_code,
              'session_id', v_recording_session_id::text,
              'station_id', NEW.station_id::text,
              'stop_at', v_stop_at,
              'reason', 'station_last_shift_closed'
            )
          );
        END IF;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- Không bật được lệnh ghi thì mất video của ca đó — nặng, nhưng chặn
    -- luôn việc mở ca thì nhân viên không làm việc được và cũng không có
    -- video. Ghi cảnh báo để truy vết, cho ca mở tiếp.
    RAISE WARNING 'enqueue_session_recording_commands (%, station %): %',
      v_action, NEW.station_id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_session_recording_commands() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_session_recording_commands() FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_session_recording_commands() FROM authenticated;

DROP TRIGGER IF EXISTS staff_work_sessions_recording_commands
  ON public.staff_work_sessions;
CREATE TRIGGER staff_work_sessions_recording_commands
AFTER INSERT OR UPDATE OF status ON public.staff_work_sessions
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_session_recording_commands();

COMMIT;
