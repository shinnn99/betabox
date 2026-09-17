-- Ghi camera góc QR theo ca kể cả khi bàn quét bằng súng.
--
-- Lỗi: trigger 20260917090000 chỉ bật ghi camera `proof_qr` khi bàn đặt
-- scan_source = 'camera'. Nhưng video bằng chứng luôn ghép góc QR nếu bàn có
-- (src/lib/agent-commands/cut-clip-planning.ts) — `scan_source` chỉ quyết
-- định thiết bị nào được TẠO lượt quét. Bàn dùng súng + camera QR vì thế mở
-- ca mà không có segment góc QR để cắt; bàn chỉ có camera QR thì không ghi gì.
--
-- Phát hiện 17/09/2026: mở ca BAN_01 (scanner, chỉ có EZVIZ_1 góc QR) không
-- ra lệnh start_recording nào.
--
-- Chỉ thay điều kiện chọn camera; phần còn lại của hàm giữ nguyên.

BEGIN;

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

COMMIT;
