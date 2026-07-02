-- Lát 1.2: HEVC "ép H.264" — cột codec onboard trên cameras.
--
-- Hai nguồn codec trong hệ (bổ sung cho nhau, không thay thế):
--   1. cameras.codec_detected — probe onboard-time (mới thêm ở đây).
--      Bắt ca camera VỪA LẮP HEVC, chưa từng recording lần nào. Nếu
--      chỉ đọc session recording, ca này banner câm vì không có
--      session để đọc.
--   2. camera_recording_sessions.codec_detected — probe recording-time
--      (đã có từ 3b-2). Bắt ca camera đổi codec giữa chừng (firmware
--      update, đổi setting).
--
-- Banner dashboard đọc UNION 2 nguồn: hiện nếu BẤT KỲ nguồn nào có
-- codec ≠ 'h264' AND ≠ NULL (null = chưa biết, không tính là hevc).
-- Tắt khi mọi nguồn có giá trị đều là 'h264' (nguồn null bỏ qua).
--
-- Cột KHÔNG thêm `is_hevc_warning_active` (redundant) — derive từ
-- codec_detected != 'h264' AND codec_detected IS NOT NULL.

alter table public.cameras
  add column codec_detected text,
  add column codec_warning text,
  add column codec_probed_at timestamptz,
  add column codec_probe_error text;

comment on column public.cameras.codec_detected is
  '1.2: codec probe onboard-time (h264, hevc, mpeg4...). NULL = chưa probe hoặc probe fail.';
comment on column public.cameras.codec_warning is
  '1.2: diễn giải codec_detected (VD not_browser_safe khi ≠ h264). NULL = codec ok hoặc chưa probe.';
comment on column public.cameras.codec_probed_at is
  '1.2: thời điểm probe cuối. Null = chưa probe lần nào.';
comment on column public.cameras.codec_probe_error is
  '1.2: reason khi probe fail (spawn_error, timeout, exit_N...). NULL = probe ok hoặc chưa probe.';

-- ---------------------------------------------------------------
-- Thêm 'probe_codec' vào agent_commands.type CHECK constraint.
-- ---------------------------------------------------------------
alter table public.agent_commands
  drop constraint agent_commands_type_check;

alter table public.agent_commands
  add constraint agent_commands_type_check
  check (type in ('ping', 'start_recording', 'stop_recording', 'cut_clip', 'upload_clip', 'probe_codec'));
