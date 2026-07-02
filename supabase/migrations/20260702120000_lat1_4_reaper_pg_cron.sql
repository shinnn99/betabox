-- Lát 1.4: reaper toàn cục pg_cron.
--
-- Hai việc dọn "agent chết im lặng" — cả hai chạy trong một pg_cron job.
--
-- Việc 1 — CẦN NGAY (1 agent cũng gặp):
--   Session `camera_recording_sessions` mồ côi: status='recording',
--   stopped_at IS NULL, last_heartbeat_at cũ hơn ngưỡng. Xảy ra khi
--   agent restart giữa recording (ffmpeg còn chạy nhưng agent process
--   mới không claim lại session cũ). Đã gặp CAM_HONG_TEST ở 3b-2.
--   Reap: mark stopped, ghi error_message='reaper_orphan_heartbeat_stale'.
--
-- Việc 2 — HOÃN ĐƯỢC tới kho-2 (chỉ cần multi-agent), nhưng làm cùng
--   vì rẻ:
--   `agent_commands.status='taken'` quá visibility timeout của agent
--   đã chết → về pending để lần poll agent kế tiếp claim lại. Với 1
--   agent piggy-back per-agent tự cứu khi agent sống lại; pg_cron
--   toàn cục cần khi agent chết hẳn (multi-agent) hoặc muốn dọn ngay
--   không đợi agent sống lại. Dùng lại RPC `reap_stale_agent_commands`
--   sẵn có (từ Lát 1).
--
-- Ngưỡng heartbeat stale: 5 phút. Heartbeat được update mỗi lần poll
-- (~3s theo POLL_INTERVAL_MS). 5 phút = ~100 miss poll — đủ tự tin
-- agent thật sự chết, không phải hiccup mạng LAN kho ngắn.
--
-- pg_cron interval: mỗi phút (`* * * * *`). Vì độ trễ reap thật = interval,
-- không phải visibility timeout. Timeout `cut_clip`/`upload_clip` là 2 phút;
-- reap mỗi phút cho tổng độ trễ tối đa ~3 phút — chấp nhận được với user
-- đang poll watch page mỗi 2s.

-- ---------------------------------------------------------------
-- Function: reap_orphan_recording_sessions
-- ---------------------------------------------------------------
create or replace function public.reap_orphan_recording_sessions()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  with reaped as (
    update public.camera_recording_sessions
    set status = 'stopped',
        stopped_at = now(),
        error_message = coalesce(error_message, '') ||
          case when error_message is null or error_message = '' then '' else '; ' end ||
          'reaper_orphan_heartbeat_stale',
        updated_at = now()
    where status = 'recording'
      and stopped_at is null
      and (
        last_heartbeat_at is null
        or last_heartbeat_at < now() - interval '5 minutes'
      )
    returning id
  )
  select count(*) into v_count from reaped;
  return v_count;
end;
$$;

revoke execute on function public.reap_orphan_recording_sessions() from public;
revoke execute on function public.reap_orphan_recording_sessions() from anon;
revoke execute on function public.reap_orphan_recording_sessions() from authenticated;

comment on function public.reap_orphan_recording_sessions() is
  '1.4: dọn session recording mồ côi. status=recording + stopped_at NULL + last_heartbeat_at cũ hơn 5 phút → mark stopped. Chạy bởi pg_cron mỗi phút.';

-- ---------------------------------------------------------------
-- pg_cron job: reap-stale-every-minute
-- ---------------------------------------------------------------
-- Đơn: unschedule nếu đã có (idempotent apply migration).
do $$
begin
  perform cron.unschedule('reap-stale-every-minute');
exception when others then
  -- job chưa tồn tại, bỏ qua.
  null;
end;
$$;

select cron.schedule(
  'reap-stale-every-minute',
  '* * * * *',
  $reap$
    select public.reap_orphan_recording_sessions();
    select public.reap_stale_agent_commands(null);
  $reap$
);
