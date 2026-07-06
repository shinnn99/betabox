-- ============================================================================
-- B2 CRIT-2: reaper flip status = 'connection_lost' thay vì 'stopped' khi
-- mất heartbeat. Cho phép poll rescue kéo về 'recording' khi agent reconnect.
--
-- Bối cảnh review Vòng B:
--   Reaper hiện tại flip session recording→stopped + stopped_at=now() sau
--   5 phút mất heartbeat. Nếu kho mất WAN >5 phút (LAN + ffmpeg vẫn OK,
--   chỉ mất kết nối cloud):
--     - DB nói stopped, UI hiển thị "Đã dừng".
--     - ffmpeg thật vẫn ghi đầy ổ.
--     - Clip pipeline dùng camera_recording_sessions.stopped_at → resolver
--       lấy bounds sai.
--     - User bấm Start lại → CRIT-1 lặp (2 ffmpeg cùng camera).
--   Poll rescue chỉ cover status IN ('recording', 'error') → không kéo được
--   session đã 'stopped' về (comment cố ý — không đè quyết định user).
--
-- Fix (2 tầng):
--   1. Migration này: thêm 'connection_lost' vào CHECK constraint. Reaper
--      flip 'recording' → 'connection_lost' (KHÔNG set stopped_at) khi heartbeat
--      cũ hơn 15 phút (nới từ 5 phút để giảm false positive khi mạng flake).
--   2. Poll rescue (route poll-commands, patch code song song): thêm
--      'connection_lost' vào .in("status", [...]) → khi agent reconnect,
--      session tự kéo về 'recording'.
--
-- Trạng thái mới:
--   - 'recording'         → ffmpeg đang chạy (agent confirmed).
--   - 'connection_lost'   → cloud mất liên lạc agent > 15 phút, KHÔNG biết
--                           ffmpeg còn chạy hay không. UI hiển thị "Mất kết
--                           nối kho" khác với "Đã dừng".
--   - 'stopped'           → user chủ động dừng (agent xác nhận đã kill ffmpeg).
--   - 'error'             → agent report lỗi cụ thể (ffmpeg exit permanent).
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.
-- ============================================================================

BEGIN;

-- 1. Mở CHECK constraint để cho phép 'connection_lost'
ALTER TABLE public.camera_recording_sessions
  DROP CONSTRAINT IF EXISTS camera_recording_sessions_status_check;

ALTER TABLE public.camera_recording_sessions
  ADD CONSTRAINT camera_recording_sessions_status_check
  CHECK (status = ANY (ARRAY[
    'recording'::text,
    'stopped'::text,
    'error'::text,
    'connection_lost'::text
  ]));

-- 2. Redesign reaper function
CREATE OR REPLACE FUNCTION public.reap_orphan_recording_sessions()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  -- Flip 'recording' → 'connection_lost' khi mất heartbeat > 15 phút.
  -- KHÔNG set stopped_at (agent có thể vẫn đang ghi, cloud chỉ mất
  -- liên lạc). Poll rescue sẽ kéo về 'recording' khi agent reconnect.
  --
  -- Nới ngưỡng từ 5 phút → 15 phút vì:
  --   - False positive: kho mất WAN ngắn (VD router reboot 2-3 phút) không
  --     nên flip session.
  --   - Buffer đủ cho agent reconnect sau khi mạng ổn.
  --   - Reaper chạy mỗi phút → delay flip = 15-16 phút.
  WITH reaped AS (
    UPDATE public.camera_recording_sessions
    SET status = 'connection_lost',
        error_message = coalesce(error_message, '') ||
          CASE WHEN error_message IS NULL OR error_message = '' THEN '' ELSE '; ' END ||
          'reaper_heartbeat_stale_15min',
        updated_at = now()
    WHERE status = 'recording'
      AND stopped_at IS NULL
      AND (
        last_heartbeat_at IS NULL
        OR last_heartbeat_at < now() - interval '15 minutes'
      )
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM reaped;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.reap_orphan_recording_sessions() IS
  'B2 CRIT-2: dọn session mất heartbeat > 15 phút. Flip recording→connection_lost '
  '(KHÔNG stopped_at) để poll rescue kéo về khi agent reconnect. Nới ngưỡng '
  'từ 5 → 15 phút giảm false positive khi mạng flake ngắn.';

-- Postcondition guard
DO $$
BEGIN
  -- 1. CHECK constraint có 'connection_lost'
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class cl ON con.conrelid = cl.oid
    JOIN pg_namespace ns ON cl.relnamespace = ns.oid
    WHERE ns.nspname = 'public'
      AND cl.relname = 'camera_recording_sessions'
      AND con.conname = 'camera_recording_sessions_status_check'
      AND pg_get_constraintdef(con.oid) LIKE '%connection_lost%'
  ) THEN
    RAISE EXCEPTION 'b2 postcondition failed: connection_lost not in CHECK constraint';
  END IF;

  -- 2. Reaper function updated (comment chứa 'B2')
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass
    WHERE n.nspname = 'public'
      AND p.proname = 'reap_orphan_recording_sessions'
      AND d.description LIKE '%B2 CRIT-2%'
  ) THEN
    RAISE EXCEPTION 'b2 postcondition failed: reaper function comment not updated';
  END IF;
END $$;

COMMIT;
