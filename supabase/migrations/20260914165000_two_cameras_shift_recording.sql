-- C.1.2 / M10: drive camera recording from the first/last active staff
-- session at a station. All decisions are scoped to the station's active
-- agent and role-aware camera assignments.

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

  FOR v_camera IN
    SELECT DISTINCT
      c.id AS camera_id,
      c.camera_code,
      c.agent_id,
      c.organization_id,
      sd.config_json->>'role' AS camera_role,
      ps.scan_source
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
     AND wa.station_id = sda.station_id
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
      -- A newly opened shift supersedes a pending delayed stop. A stop
      -- already taken by the agent is cancelled by the start command below.
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
          organization_id,
          camera_id,
          status,
          transport,
          segment_seconds,
          output_dir,
          started_at,
          created_by
        ) VALUES (
          v_camera.organization_id,
          v_camera.camera_id,
          'recording',
          'tcp',
          60,
          '_agent_managed/' || v_camera.camera_code,
          now(),
          NULL
        )
        RETURNING id INTO v_recording_session_id;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM public.agent_commands ac
        WHERE ac.organization_id = v_camera.organization_id
          AND ac.agent_id = v_camera.agent_id
          AND ac.type = 'start_recording'
          AND ac.status IN ('pending', 'taken')
          AND ac.payload->>'camera_id' = v_camera.camera_id::text
      ) THEN
        INSERT INTO public.agent_commands (
          organization_id,
          agent_id,
          type,
          payload
        ) VALUES (
          v_camera.organization_id,
          v_camera.agent_id,
          'start_recording',
          jsonb_build_object(
            'camera_id', v_camera.camera_id::text,
            'camera_code', v_camera.camera_code,
            'session_id', v_recording_session_id::text,
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
        SELECT 1
        FROM public.agent_commands ac
        WHERE ac.organization_id = v_camera.organization_id
          AND ac.agent_id = v_camera.agent_id
          AND ac.type = 'stop_recording'
          AND ac.status IN ('pending', 'taken')
          AND ac.payload->>'camera_id' = v_camera.camera_id::text
          AND ac.payload->>'session_id' = v_recording_session_id::text
      ) THEN
        INSERT INTO public.agent_commands (
          organization_id,
          agent_id,
          type,
          payload
        ) VALUES (
          v_camera.organization_id,
          v_camera.agent_id,
          'stop_recording',
          jsonb_build_object(
            'camera_id', v_camera.camera_id::text,
            'camera_code', v_camera.camera_code,
            'session_id', v_recording_session_id::text,
            'stop_at', v_stop_at,
            'reason', 'station_last_shift_closed'
          )
        );
      END IF;
    END IF;
  END LOOP;

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
