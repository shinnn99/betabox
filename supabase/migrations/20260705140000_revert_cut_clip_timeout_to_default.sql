-- Revert băng cứu thương 20260705120000: cut_clip timeout về 2 phút.
--
-- Bối cảnh (2026-07-05, sau khi fix 2 code deploy): agent giờ luôn
-- copy-stream cho cut_clip (không burn/overlay/mark). Clip 10 phút
-- cắt ~1-3 giây thay vì reencode 16-20 phút → visibility timeout 30
-- phút thừa xa. Về mức mặc định 2 phút cho nhất quán các type khác.
--
-- Vì sao revert dù không bắt buộc:
--   Timeout dài mà tiến trình thật ngắn = che triệu chứng agent hang.
--   Nếu ffmpeg copy-stream hang thật (ổ đọc treo, segment corrupt),
--   30 phút để user chờ oan; 2 phút reap sớm + trả lại pending cho
--   tick sau claim là đúng ý. Băng cứu thương chỉ đúng khi có việc
--   reencode dài — không còn thì dọn.
--
-- Timeout khác không đổi:
--   ping           30 seconds
--   (mặc định)     2 minutes  ← cut_clip trở về đây
--
-- Về sau nếu có type reencode thật (VD nếu quyết định thêm lại burn
-- on-demand cho export ra ngoài) → thêm nhánh CASE riêng cho type
-- đó, không nới mặc định.

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
