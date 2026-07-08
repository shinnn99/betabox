-- LAN discovery command type (2026-07-08)
--
-- Cloud enqueue `discover_lan` để agent quét camera trên LAN kho. Trước
-- đây scanForCameras chạy trên Next.js server; SaaS topology chuyển sang
-- command-queue vì Vercel POP không thấy 192.168.x của LAN khách.
--
-- Xem project_lan_discovery_agent_migration.md để hiểu bối cảnh.

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
    'test_camera_draft',
    'discover_lan'
  ));
