-- ============================================================================
-- B4 HIGH-12: RPC transactional cho enqueue_start_recording.
--
-- Bối cảnh review Vòng B: race double-start (double-click hoặc 2 tab):
--   - Producer route SELECT active session → INSERT session recording +
--     INSERT command start_recording (2 request sequential SELECT rồi INSERT).
--   - Race: 2 request cùng qua SELECT (chưa có active) → 2 INSERT → 2 command.
--     Agent claim command 2 nhận sessionId khác — reaper flip session A khi
--     agent tick sessionId B → DB lệch.
--
-- Fix (chốt B4 sau prompt user):
--   Q1: Giữ session state machine hiện tại ('recording', 'stopped', 'error',
--       'connection_lost' — thêm bởi B2 CRIT-2). KHÔNG thêm 'pending'/'stopping'.
--       RPC check cả session VÀ agent_commands active.
--   Q2: pg_advisory_xact_lock (blocking) — race Start là bình thường từ
--       double-click, phải idempotent. Timeout via SET LOCAL lock_timeout.
--
-- Active set:
--   Session: status IN ('recording', 'connection_lost')
--   Command: type='start_recording' AND status IN ('pending', 'taken')
--
-- Verdicts:
--   'already_recording' → session recording tồn tại (agent đang ghi thật).
--   'recording_state_unknown' → session connection_lost (không rõ ffmpeg
--     còn ghi hay không; user KHÔNG nên start mới đến khi cloud reconnect).
--   'start_pending' → command chưa done (agent chưa spawn).
--   'created' → tạo mới session+command atomic.
--
-- Advisory lock key:
--   pg_advisory_xact_lock(hashtextextended(p_camera_id::text, 824731)::bigint)
--   Seed 824731 là namespace "start_recording" của Betacom. 64-bit hash
--   giảm collision so với hashtext (32-bit).
--
-- Không đổi CHECK constraint session (giữ nguyên).
-- Không đổi CHECK constraint agent_commands.
-- Giữ idx_one_active_recording_per_camera làm backstop cuối.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.enqueue_start_recording(
  p_organization_id uuid,
  p_camera_id uuid,
  p_agent_id uuid,
  p_created_by uuid,
  p_transport text,
  p_segment_seconds integer,
  p_output_dir text
)
RETURNS TABLE (
  verdict text,
  session_id uuid,
  command_id uuid,
  reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lock_key bigint;
  v_existing_session record;
  v_existing_command_id uuid;
  v_new_session_id uuid;
  v_new_command_id uuid;
BEGIN
  -- Sanity.
  IF p_organization_id IS NULL OR p_camera_id IS NULL OR p_agent_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_start_invalid_args' USING ERRCODE = 'P0001';
  END IF;
  IF p_transport NOT IN ('tcp', 'udp') THEN
    RAISE EXCEPTION 'enqueue_start_transport_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_segment_seconds < 5 OR p_segment_seconds > 3600 THEN
    RAISE EXCEPTION 'enqueue_start_segment_seconds_invalid' USING ERRCODE = 'P0001';
  END IF;

  -- Verify camera thuộc org.
  PERFORM 1 FROM public.cameras
    WHERE id = p_camera_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_start_camera_not_in_org' USING ERRCODE = 'P0001';
  END IF;

  -- Verify agent thuộc org.
  PERFORM 1 FROM public.warehouse_agents
    WHERE id = p_agent_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_start_agent_not_in_org' USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock 64-bit hash per camera. Blocking — 2 request đồng thời
  -- serialize; request 2 chờ request 1 xong rồi đọc lại state.
  -- SET LOCAL lock_timeout ở CALLER phía backend qua SET LOCAL bên ngoài
  -- (function SECURITY DEFINER không nhận GUC từ session ngoài tx).
  v_lock_key := hashtextextended(p_camera_id::text, 824731);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Check active session (recording hoặc connection_lost).
  SELECT id, status INTO v_existing_session
  FROM public.camera_recording_sessions
  WHERE camera_id = p_camera_id
    AND organization_id = p_organization_id
    AND status IN ('recording', 'connection_lost')
  ORDER BY started_at DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_existing_session.status = 'recording' THEN
      RETURN QUERY SELECT
        'already_recording'::text,
        v_existing_session.id,
        NULL::uuid,
        NULL::text;
      RETURN;
    ELSE
      -- connection_lost: KHÔNG start mới. Trạng thái không rõ.
      RETURN QUERY SELECT
        'recording_state_unknown'::text,
        v_existing_session.id,
        NULL::uuid,
        'session_connection_lost — reconnect agent để rescue, không start mới'::text;
      RETURN;
    END IF;
  END IF;

  -- Check pending/taken start_recording command (agent chưa xử xong).
  SELECT id INTO v_existing_command_id
  FROM public.agent_commands
  WHERE type = 'start_recording'
    AND organization_id = p_organization_id
    AND status IN ('pending', 'taken')
    AND (payload->>'camera_id')::uuid = p_camera_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT
      'start_pending'::text,
      NULL::uuid,
      v_existing_command_id,
      NULL::text;
    RETURN;
  END IF;

  -- Không có gì active → tạo session + command atomically.
  INSERT INTO public.camera_recording_sessions(
    organization_id, camera_id, status, transport, segment_seconds,
    output_dir, started_at, created_by
  )
  VALUES (
    p_organization_id, p_camera_id, 'recording', p_transport, p_segment_seconds,
    p_output_dir, now(), p_created_by
  )
  RETURNING id INTO v_new_session_id;

  INSERT INTO public.agent_commands(
    organization_id, agent_id, type, payload
  )
  VALUES (
    p_organization_id,
    p_agent_id,
    'start_recording',
    jsonb_build_object(
      'camera_id', p_camera_id::text,
      'session_id', v_new_session_id::text,
      'transport', p_transport,
      'segment_seconds', p_segment_seconds,
      'output_dir', p_output_dir
    )
  )
  RETURNING id INTO v_new_command_id;

  RETURN QUERY SELECT
    'created'::text,
    v_new_session_id,
    v_new_command_id,
    NULL::text;
END;
$$;

COMMENT ON FUNCTION public.enqueue_start_recording(
  uuid, uuid, uuid, uuid, text, integer, text
) IS
  'B4 HIGH-12: transactional Start Recording. Advisory xact lock per camera + '
  'kiểm session (recording, connection_lost) + command (pending, taken). '
  'Verdicts: already_recording | recording_state_unknown | start_pending | created. '
  'Defense-in-depth: idx_one_active_recording_per_camera unique index vẫn giữ.';

REVOKE ALL ON FUNCTION public.enqueue_start_recording(
  uuid, uuid, uuid, uuid, text, integer, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_start_recording(
  uuid, uuid, uuid, uuid, text, integer, text
) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_start_recording(
  uuid, uuid, uuid, uuid, text, integer, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_start_recording(
  uuid, uuid, uuid, uuid, text, integer, text
) TO service_role;

-- Postcondition guard: function exists + ACL đúng.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'enqueue_start_recording'
  ) THEN
    RAISE EXCEPTION 'b4 postcondition failed: enqueue_start_recording not created';
  END IF;
  IF has_function_privilege('anon', 'public.enqueue_start_recording(uuid, uuid, uuid, uuid, text, integer, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enqueue_start_recording(uuid, uuid, uuid, uuid, text, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'b4 postcondition failed: anon/authenticated has EXECUTE on enqueue_start_recording';
  END IF;
END $$;

COMMIT;
