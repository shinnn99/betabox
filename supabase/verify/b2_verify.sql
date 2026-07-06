-- ============================================================================
-- B2 verification script.
--
-- Section 1-3 READ-ONLY: safe post-apply migration 20260707200000.
-- Section 4 DESTRUCTIVE: BEGIN/ROLLBACK, chỉ chạy Supabase branch/local.
-- ============================================================================

-- ============================================================================
-- SECTION 1 (READ-ONLY): CHECK constraint có 'connection_lost'
-- ============================================================================
SELECT
  con.conname,
  pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class cl ON con.conrelid = cl.oid
JOIN pg_namespace ns ON cl.relnamespace = ns.oid
WHERE ns.nspname = 'public'
  AND cl.relname = 'camera_recording_sessions'
  AND con.conname = 'camera_recording_sessions_status_check';
-- Kỳ vọng: def chứa 'recording', 'stopped', 'error', 'connection_lost'.

-- ============================================================================
-- SECTION 2 (READ-ONLY): reaper function updated
-- ============================================================================
SELECT
  p.proname,
  p.prosecdef,
  array_to_string(p.proconfig, ' ') AS config,
  d.description
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass
WHERE n.nspname = 'public' AND p.proname = 'reap_orphan_recording_sessions';
-- Kỳ vọng: description chứa 'B2 CRIT-2'.

-- ============================================================================
-- SECTION 3 (READ-ONLY): pg_cron reaper vẫn schedule
-- ============================================================================
SELECT jobname, schedule, active FROM cron.job
WHERE jobname = 'reap-stale-every-minute';
-- Kỳ vọng: schedule='* * * * *', active=true.

-- ============================================================================
-- SECTION 4 (DESTRUCTIVE — branch only): reaper behavior
-- ============================================================================

/*
BEGIN;

-- Seed org + camera + session recording không có heartbeat
INSERT INTO public.organizations(id, name, slug, status)
VALUES ('11111111-1111-1111-1111-1111b2000000'::uuid, 'B2 test', 'b2-test', 'active');

INSERT INTO public.cameras(id, organization_id, name, camera_code, ip, rtsp_port, rtsp_path, username, status)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaab2000000'::uuid,
  '11111111-1111-1111-1111-1111b2000000'::uuid,
  'B2 cam', 'B2_CAM', '10.0.0.1', 554, '/stream', 'admin', 'active'
);

-- Case 4.1: session recording + heartbeat 20 phút trước → reaper flip
INSERT INTO public.camera_recording_sessions(
  id, organization_id, camera_id, status, transport, segment_seconds,
  output_dir, started_at, last_heartbeat_at
) VALUES (
  'ddddddd0-0000-0000-0000-000000b20001'::uuid,
  '11111111-1111-1111-1111-1111b2000000'::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaab2000000'::uuid,
  'recording', 'tcp', 60, '/tmp/b2',
  now() - interval '30 minutes',
  now() - interval '20 minutes'
);

SELECT public.reap_orphan_recording_sessions() AS reaped_count;
-- Kỳ vọng: 1.

-- Verify: session mới status='connection_lost', stopped_at IS NULL
SELECT id, status, stopped_at, error_message
FROM public.camera_recording_sessions
WHERE id = 'ddddddd0-0000-0000-0000-000000b20001'::uuid;
-- Kỳ vọng: status=connection_lost, stopped_at=NULL, error_message chứa
-- 'reaper_heartbeat_stale_15min'.

-- Case 4.2: session recording + heartbeat 10 phút trước → KHÔNG reap (< 15 phút)
UPDATE public.camera_recording_sessions
SET status = 'recording',
    last_heartbeat_at = now() - interval '10 minutes',
    error_message = NULL
WHERE id = 'ddddddd0-0000-0000-0000-000000b20001'::uuid;

SELECT public.reap_orphan_recording_sessions() AS reaped_count_2;
-- Kỳ vọng: 0.

-- Case 4.3: rescue path — poll với active_recordings kéo connection_lost → recording
UPDATE public.camera_recording_sessions
SET status = 'connection_lost',
    last_heartbeat_at = now() - interval '20 minutes'
WHERE id = 'ddddddd0-0000-0000-0000-000000b20001'::uuid;

UPDATE public.camera_recording_sessions
SET status = 'recording',
    last_heartbeat_at = now(),
    stopped_at = NULL,
    error_message = NULL
WHERE id = 'ddddddd0-0000-0000-0000-000000b20001'::uuid
  AND status = ANY(ARRAY['recording','error','connection_lost']::text[]);

SELECT id, status, last_heartbeat_at > now() - interval '1 minute' AS heartbeat_fresh
FROM public.camera_recording_sessions
WHERE id = 'ddddddd0-0000-0000-0000-000000b20001'::uuid;
-- Kỳ vọng: status=recording, heartbeat_fresh=true.

ROLLBACK;
*/
