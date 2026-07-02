-- P1 race fix: enforce one active 'recording' session per camera in DB.
--
-- Why partial: rows in 'stopped' or 'error' are history; the constraint
-- only applies to live sessions. Verified 2026-06-30 that there are
-- currently 0 rows at status='recording' (so this index creates cleanly
-- with no preceding deduplication step needed). The pre-apply check ran
-- via:
--   select camera_id, count(*) from public.camera_recording_sessions
--   where status='recording' group by camera_id having count(*) > 1;
-- which returned no rows.
--
-- Rollback note (manual): DROP INDEX public.idx_one_active_recording_per_camera
-- if the operator decides that running multiple ffmpeg copies for the
-- same camera is legitimate behaviour. That would be a regression of the
-- HMR/restart race fix, so weigh it carefully.

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_recording_per_camera
  ON public.camera_recording_sessions (camera_id)
  WHERE status = 'recording';
