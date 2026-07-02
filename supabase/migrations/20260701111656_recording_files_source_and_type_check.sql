-- Lát 3a-1: nền cho segment index. Bốn việc trong một migration để 3a-2
-- không cần thêm migration nào cho type constraint.
--
-- 1) Mở rộng CHECK constraint agent_commands.type để nhận 'cut_clip'
--    (3a-2 sẽ dùng, thêm sẵn để đỡ thêm migration).
-- 2) Xóa 52 row rác test trong camera_recording_files (2026-06-28..29,
--    trước khi Lát 1 bắt đầu 2026-07-01 — không có data khách).
-- 3) Thêm cột source ('agent'|'legacy_nextjs') để 3a-2 filter được
--    row do agent ghi, không lẫn với row do route Next.js cũ ghi nếu
--    có ai lỡ chạy lại.
-- 4) Unique index (organization_id, camera_id, file_path) để upsert
--    theo file_path hoạt động đúng, và chặn row trùng file_path từ
--    route cũ + agent.

-- 1) Type CHECK: drop cũ + add mới có 'cut_clip'.
alter table public.agent_commands
  drop constraint agent_commands_type_check;

alter table public.agent_commands
  add constraint agent_commands_type_check
  check (type in ('ping', 'start_recording', 'stop_recording', 'cut_clip'));

-- 2) Xóa rác test. Xác nhận trước áp: oldest 2026-06-28, newest
--    2026-06-29, cameras=2 — data test giai đoạn cũ trước Lát 1
--    (2026-07-01). Không có RLS policy hạn chế DELETE cho service_role
--    nên câu này chạy được.
delete from public.camera_recording_files;

-- 3) Cột source. Default 'agent' vì agent Lát 3a-1 là consumer chính
--    của bảng này từ giờ. Route Next.js cũ (nếu vẫn dùng) phải ghi
--    'legacy_nextjs' — cắm cọc trong route cũ ở step tiếp theo.
alter table public.camera_recording_files
  add column source text not null default 'agent'
  check (source in ('agent', 'legacy_nextjs'));

-- 4) Unique key cho upsert. File_path là relative với RECORDING_DIR
--    của agent (ví dụ 'cam_01/2026/07/01/cam_01_20260701_105856.mp4').
create unique index camera_recording_files_camera_path_uniq
  on public.camera_recording_files (organization_id, camera_id, file_path);
