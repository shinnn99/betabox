-- Fix 1 (băng cứu thương): reaper timeout theo type, tách cut_clip.
--
-- Bối cảnh (2026-07-05): quan sát nhiều clip cut_clip kẹt vòng lặp
-- taken_count=3, gốc là burn-in reencode mọi clip lúc cắt. Clip dài
-- 8-10 phút reencode 16-20 phút → vượt visibility timeout 2 phút của
-- reaper → reap kéo về 'pending' → agent claim lại → vòng lặp cho tới
-- khi taken_count exhaust.
--
-- Fix 2 (chữa gốc, đang làm song song): cut về `-c copy` cho MỌI clip,
-- burn tách sang command riêng chỉ khi user bấm xuất bằng chứng. Khi
-- fix 2 deploy xong, cut_clip trở về vài giây/clip → timeout 2 phút cũ
-- dư sức, migration này có thể REVERT về CASE cũ.
--
-- Fix 1 là băng cứu thương: KHÔNG giải gốc chậm (agent vẫn kẹt 20 phút/
-- clip đang reencode), chỉ dừng vòng lặp reap-claim-reap. Clip đang
-- reencode chạy tới cùng thay vì bị reap giữa chừng.
--
-- Cách chọn 30 phút:
--   Reencode clip 10 phút (trần mới sau khi Hạnh nâng 3→10) ≈ 16-20
--   phút thực tế trên agent kho (i5 hoặc yếu hơn). Cộng margin 30-50%
--   phòng máy yếu/tải cao → 30 phút. Không 60 phút vì nếu ffmpeg hang
--   thật, 30 phút đủ ngắn để reap-and-retry còn có ý nghĩa; 60 phút
--   để user chờ quá lâu ở watch page.
--
-- upload_clip GIỮ 2 phút:
--   Upload signed URL clip <100MB trên LAN kho + mạng WAN → vài giây.
--   Nếu quá 2 phút = mạng hỏng thật, reap-and-retry là đúng ý.
--
-- Cọc kỹ thuật đã ghi ở migration 20260701092259 (agent_commands.sql
-- docstring "Note timeout theo type"): khi type nhiều lên, chuyển sang
-- cột visibility_timeout_ms trên bảng thay vì CASE cứng. HOÃN — hiện
-- có 6 type (ping/start_recording/stop_recording/cut_clip/upload_clip/
-- probe_codec/snapshot_camera/test_camera_*), CASE còn đọc được. Chuyển
-- cột khi có type thứ 10 hoặc khi cần override per-command.

create or replace function public.reap_stale_agent_commands(p_agent_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  with reaped as (
    update public.agent_commands
    set status = 'pending',
        taken_at = null,
        updated_at = now()
    where status = 'taken'
      and (p_agent_id is null or agent_id = p_agent_id)
      and taken_at < now() - (
        case type
          when 'ping' then interval '30 seconds'
          when 'cut_clip' then interval '30 minutes'
          else interval '2 minutes'
        end
      )
    returning id
  )
  select count(*) into v_count from reaped;
  return v_count;
end;
$$;

revoke execute on function public.reap_stale_agent_commands(uuid) from public;
revoke execute on function public.reap_stale_agent_commands(uuid) from anon;
revoke execute on function public.reap_stale_agent_commands(uuid) from authenticated;
