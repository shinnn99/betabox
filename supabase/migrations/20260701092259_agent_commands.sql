-- Cloud → Agent command channel (Lát 1: chỉ PING).
--
-- Kênh lệnh một chiều cloud → agent. Agent short-poll POST
-- /api/agent/poll-commands mỗi vài giây; backend trả về job pending của
-- đúng agent đó và mark 'taken'. Agent xử lý xong gọi
-- /api/agent/command-result để đóng job.
--
-- Hai điểm cần đọc trước khi thêm loại job mới:
--
-- 1) At-least-once delivery. Nếu agent lấy job (taken) rồi xử lý chậm
--    hơn visibility timeout, reap_stale_agent_commands() sẽ kéo job về
--    'pending' và lần poll kế tiếp có thể claim lại → job CÓ THỂ CHẠY
--    HAI LẦN. Mọi handler job phải idempotent: đặt tên file theo
--    command_id, upsert theo key nghiệp vụ, v.v. PING vô hại nên OK ở
--    Lát 1, nhưng cut_clip / recording sau này phải tự lo.
--
-- 2) Reaper piggy-back trên poll của chính agent. Nghĩa là nếu agent
--    chết im lặng và ngừng poll, job 'taken' của agent đó KHÔNG bao giờ
--    được kéo về 'pending' — không có ai gọi reaper cho nó. Với PING
--    vô hại, với job có side-effect thật (recording chưa cắt clip xong)
--    thì cần reaper toàn cục (pg_cron gọi reap_stale_agent_commands với
--    p_agent_id = null quét toàn bộ) — chưa làm ở Lát 1.
--
--    NGHIÊM RỘNG (bổ sung sau lần bắt gặp triệu chứng thật): reaper
--    toàn cục KHÔNG chỉ dọn agent_commands.status='taken'. Nó phải dọn
--    cả camera_recording_sessions.status='recording' mà không có
--    stopped_at và quá hạn heartbeat (last_heartbeat_at cũ hơn N phút).
--    Đây là hai mảnh của CÙNG một cọc "agent chết im lặng, DB không
--    được dọn" — session recording mồ côi cùng gốc với job taken mồ
--    côi. Nếu chỉ làm reaper cho agent_commands, mỗi lần agent chết
--    session recording vẫn kẹt lại 'recording' trong DB. Đã gặp triệu
--    chứng trong lúc setup 3b-2 (CAM_HONG_TEST session không stopped
--    dù agent bỏ recording đó từ lâu).
--
-- Note timeout theo type: Lát 1 hai type ('ping' 30s, else 2 min) nên
-- dùng CASE hardcoded trong reaper là đơn giản nhất. Khi type nhiều lên
-- (recording, cut_clip, ...), CASE sẽ dài và dễ lệch — chuyển sang
-- cột visibility_timeout_ms trên chính bảng (set lúc insert theo type)
-- và bỏ CASE. Đừng cố tự sinh CASE từ code TS: đó là dựng SQL động ở
-- đường hot, đổi rủi ro lệch số lấy rủi ro cú pháp/injection.

create table if not exists public.agent_commands (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id        uuid not null references public.warehouse_agents(id) on delete cascade,

  type            text not null,
  payload         jsonb not null default '{}'::jsonb,

  status          text not null default 'pending'
                    check (status in ('pending','taken','done','failed')),

  taken_at        timestamptz,
  taken_count     int not null default 0,
  completed_at    timestamptz,
  result          jsonb,
  error           text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists agent_commands_agent_pending_idx
  on public.agent_commands (agent_id, created_at)
  where status = 'pending';

create index if not exists agent_commands_taken_idx
  on public.agent_commands (status, taken_at)
  where status = 'taken';

alter table public.agent_commands enable row level security;

-- No policies: chỉ service-role (backend) đụng bảng. Cùng pattern như
-- warehouse_agents.secret. UI muốn xem status thì gọi qua API server.

-- ---------------------------------------------------------------
-- RPC: reap_stale_agent_commands
-- Kéo job 'taken' đã quá visibility timeout về 'pending'. Timeout đọc
-- theo type: 'ping' 30s, mặc định 2 phút.
--
-- p_agent_id = null → quét toàn bộ agent (dành cho reaper toàn cục sau
-- này, ví dụ pg_cron). p_agent_id != null → chỉ agent đó (piggy-back
-- trong route poll).
-- ---------------------------------------------------------------
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

-- ---------------------------------------------------------------
-- RPC: claim_agent_commands
-- Atomic claim: chọn job 'pending' cũ nhất của agent, mark 'taken',
-- trả về id/type/payload. FOR UPDATE SKIP LOCKED chống race khi có
-- hai poll cùng lúc (ví dụ user chạy nhầm 2 process agent).
-- ---------------------------------------------------------------
create or replace function public.claim_agent_commands(
  p_agent_id uuid,
  p_limit    int default 20
)
returns table (
  id       uuid,
  type     text,
  payload  jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select c.id
    from public.agent_commands c
    where c.agent_id = p_agent_id
      and c.status = 'pending'
    order by c.created_at
    limit greatest(p_limit, 1)
    for update skip locked
  )
  update public.agent_commands c
  set status = 'taken',
      taken_at = now(),
      taken_count = c.taken_count + 1,
      updated_at = now()
  from picked
  where c.id = picked.id
  returning c.id, c.type, c.payload;
end;
$$;

revoke execute on function public.claim_agent_commands(uuid, int) from public;
revoke execute on function public.claim_agent_commands(uuid, int) from anon;
revoke execute on function public.claim_agent_commands(uuid, int) from authenticated;
