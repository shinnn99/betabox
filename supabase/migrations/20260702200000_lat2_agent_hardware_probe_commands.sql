-- Chuyển 3 endpoint chạm ffmpeg (test-connection, snapshot, test-draft)
-- sang agent-command pattern để chạy được trên cloud SaaS.
--
-- 1. Thêm 3 command types.
-- 2. Bucket `camera-snapshots-transient` cho JPEG onboard/ngắm-góc, TTL 24h.
--
-- Không đụng recording/start (sẽ xóa route, chuyển UI sang
-- enqueueStartRecording đã có).

-- ---------------------------------------------------------------
-- 1) agent_commands.type: thêm 3 loại
-- ---------------------------------------------------------------
alter table public.agent_commands
  drop constraint agent_commands_type_check;

alter table public.agent_commands
  add constraint agent_commands_type_check
  check (type in (
    'ping',
    'start_recording',
    'stop_recording',
    'cut_clip',
    'upload_clip',
    'probe_codec',
    'test_camera_connection',
    'snapshot_camera',
    'test_camera_draft'
  ));

-- ---------------------------------------------------------------
-- 2) Bucket camera-snapshots-transient
--    Cho JPEG onboard/ngắm góc. TTL 24h (cleanup manual sau, không
--    cấp thiết như clip vì snapshot chỉ dùng ngay khi lắp cam,
--    không phải bằng chứng dài hạn).
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'camera-snapshots-transient',
  'camera-snapshots-transient',
  false,                       -- private, signed URL only
  5242880,                     -- 5MB đủ cho 1 JPEG frame HD
  ARRAY['image/jpeg']::text[]  -- JPEG only
)
on conflict (id) do nothing;

-- RLS: chỉ service_role thao tác (giống proof-clips-transient).
drop policy if exists "camera_snapshots_service_role_select" on storage.objects;
drop policy if exists "camera_snapshots_service_role_insert" on storage.objects;
drop policy if exists "camera_snapshots_service_role_update" on storage.objects;
drop policy if exists "camera_snapshots_service_role_delete" on storage.objects;

create policy "camera_snapshots_service_role_select"
  on storage.objects for select
  to service_role
  using (bucket_id = 'camera-snapshots-transient');

create policy "camera_snapshots_service_role_insert"
  on storage.objects for insert
  to service_role
  with check (bucket_id = 'camera-snapshots-transient');

create policy "camera_snapshots_service_role_update"
  on storage.objects for update
  to service_role
  using (bucket_id = 'camera-snapshots-transient')
  with check (bucket_id = 'camera-snapshots-transient');

create policy "camera_snapshots_service_role_delete"
  on storage.objects for delete
  to service_role
  using (bucket_id = 'camera-snapshots-transient');
