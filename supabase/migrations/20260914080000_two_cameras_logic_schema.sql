-- A.2: Two-camera proof and session recording logic.

ALTER TABLE public.packing_events
  ADD COLUMN IF NOT EXISTS proof_qr_camera_id uuid
    REFERENCES public.cameras(id) ON DELETE SET NULL;

ALTER TABLE public.order_proof_clips
  ADD COLUMN IF NOT EXISTS qr_camera_id uuid REFERENCES public.cameras(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS angles_present jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS layout text,
  ADD COLUMN IF NOT EXISTS progress_percent integer CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS label_check jsonb;

ALTER TABLE public.order_proof_clips DROP CONSTRAINT IF EXISTS order_proof_clips_progress_state_check;
ALTER TABLE public.order_proof_clips
  ADD CONSTRAINT order_proof_clips_progress_state_check
  CHECK (progress_state IS NULL OR progress_state IN ('encoding','cutting','composing','uploading'));

CREATE TABLE IF NOT EXISTS public.order_proof_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  fail_reason text
);
CREATE INDEX IF NOT EXISTS order_proof_requests_pending_idx
  ON public.order_proof_requests (requested_at) WHERE status = 'pending';

-- Capture the QR camera at event creation, so later station-camera changes do not alter history.
CREATE OR REPLACE FUNCTION public.capture_packing_event_qr_camera()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.proof_qr_camera_id IS NULL THEN
    SELECT c.id INTO NEW.proof_qr_camera_id
    FROM public.cameras c
    JOIN public.packing_stations ps ON ps.id = NEW.station_id
    WHERE ps.scan_source = 'camera' AND c.station_id = ps.id AND c.is_active IS TRUE
    ORDER BY c.created_at NULLS LAST, c.id LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS packing_events_capture_qr_camera ON public.packing_events;
CREATE TRIGGER packing_events_capture_qr_camera
BEFORE INSERT ON public.packing_events FOR EACH ROW
EXECUTE FUNCTION public.capture_packing_event_qr_camera();

-- Queue recording commands when a work session opens/closes.
CREATE OR REPLACE FUNCTION public.enqueue_session_recording_commands()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_agent uuid; v_type text;
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status IN ('open','active','started') THEN v_type := 'start_recording';
  ELSIF NEW.status IN ('closed','ended','completed') THEN v_type := 'stop_recording';
  ELSE RETURN NEW; END IF;
  FOR v_agent IN SELECT id FROM public.warehouse_agents WHERE station_id = NEW.station_id AND status = 'active' LOOP
    INSERT INTO public.agent_commands (organization_id, agent_id, type, payload)
    SELECT wa.organization_id, v_agent, v_type,
           jsonb_build_object('station_id', NEW.station_id, 'work_session_id', NEW.id,
             'delay_seconds', CASE WHEN v_type = 'stop_recording' THEN 60 ELSE 0 END)
    FROM public.warehouse_agents wa WHERE wa.id = v_agent;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS staff_work_sessions_recording_commands ON public.staff_work_sessions;
CREATE TRIGGER staff_work_sessions_recording_commands
AFTER UPDATE OF status ON public.staff_work_sessions FOR EACH ROW
EXECUTE FUNCTION public.enqueue_session_recording_commands();
