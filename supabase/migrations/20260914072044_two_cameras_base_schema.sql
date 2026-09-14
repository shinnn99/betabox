-- A.1: Two-cameras base schema (M1, M2, M3, M4, M5, M14, M16)
--
-- Mở rộng schema cho luồng 2 camera trên mỗi bàn đóng gói.
-- Xem docs/tuan-tu-xu-ly-2-camera.md Bước 1 — Database.
--
-- Nguyên tắc: mọi cột mới nullable hoặc có default → dữ liệu cũ không đổi.

-- ============================================================================
-- M1: warehouse_agents.station_id
-- Máy tính (agent) thuộc bàn đóng gói nào. Một bàn tối đa một agent active.
-- ============================================================================
ALTER TABLE public.warehouse_agents
  ADD COLUMN IF NOT EXISTS station_id uuid
    REFERENCES public.packing_stations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.warehouse_agents.station_id IS
  'A.1/M1: bàn đóng gói mà agent này được gắn. Null = chưa gắn bàn.';

-- Unique partial index: một bàn chỉ có tối đa 1 agent đang active.
-- Agent inactive/disabled không chiếm slot.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_agents_station_active_uniq
  ON public.warehouse_agents (station_id)
  WHERE station_id IS NOT NULL AND status = 'active';

-- ============================================================================
-- M2: user_profiles.station_id
-- Tài khoản bàn (role packer) gắn với bàn nào.
-- ============================================================================
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS station_id uuid
    REFERENCES public.packing_stations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.user_profiles.station_id IS
  'A.1/M2: bàn đóng gói mà tài khoản này được gắn (chủ yếu role packer). Null = chưa gắn.';

-- ============================================================================
-- M3: packing_stations.scan_source
-- Nguồn đọc mã QR: máy quét cầm tay hoặc camera.
-- ============================================================================
ALTER TABLE public.packing_stations
  ADD COLUMN IF NOT EXISTS scan_source text NOT NULL DEFAULT 'scanner'
    CHECK (scan_source IN ('scanner', 'camera'));

COMMENT ON COLUMN public.packing_stations.scan_source IS
  'A.1/M3: nguồn đọc mã QR hiện tại — scanner (máy quét cầm tay) hoặc camera.';

-- ============================================================================
-- M4: cameras — substream, agent binding, disconnect alert
-- ============================================================================
ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS rtsp_substream_path text;

ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS agent_id uuid
    REFERENCES public.warehouse_agents(id) ON DELETE SET NULL;

ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS probe_failing_since timestamptz;

ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS disconnect_alerted_at timestamptz;

COMMENT ON COLUMN public.cameras.rtsp_substream_path IS
  'A.1/M4: đường dẫn RTSP luồng phụ (substream) để xem trực tiếp. Null = chưa cấu hình.';
COMMENT ON COLUMN public.cameras.agent_id IS
  'A.1/M4: agent đang quản lý camera này. Null = chưa gắn agent.';
COMMENT ON COLUMN public.cameras.probe_failing_since IS
  'A.1/M4: thời điểm bắt đầu chuỗi probe fail liên tiếp. Null = probe ok hoặc chưa probe.';
COMMENT ON COLUMN public.cameras.disconnect_alerted_at IS
  'A.1/M4: thời điểm đã gửi cảnh báo mất kết nối. Null = chưa gửi hoặc đã phục hồi.';

-- ============================================================================
-- M5: camera_recording_files.agent_id
-- Segment nằm trên ổ cứng máy nào → gửi lệnh cắt clip chính xác.
-- ============================================================================
ALTER TABLE public.camera_recording_files
  ADD COLUMN IF NOT EXISTS agent_id uuid
    REFERENCES public.warehouse_agents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.camera_recording_files.agent_id IS
  'A.1/M5: agent sở hữu file segment này trên ổ cứng. Null = agent chưa xác định (data cũ).';

-- ============================================================================
-- M14: agent_commands.type CHECK — thêm 4 loại lệnh mới
-- Khuôn: 20260708120000_discover_lan_command_type.sql
-- ============================================================================
ALTER TABLE public.agent_commands
  DROP CONSTRAINT agent_commands_type_check;

ALTER TABLE public.agent_commands
  ADD CONSTRAINT agent_commands_type_check
  CHECK (type IN (
    -- Existing types
    'ping',
    'start_recording',
    'stop_recording',
    'cut_clip',
    'upload_clip',
    'probe_codec',
    'test_camera_connection',
    'snapshot_camera',
    'test_camera_draft',
    'discover_lan',
    -- New types (A.1)
    'connect_camera',
    'test_qr_decode',
    'live_remote_start',
    'live_remote_stop'
  ));

-- ============================================================================
-- M16: role_permission_matrix — 3 quyền mới
-- packing_station.camera_setup → owner, admin
-- live.view_remote             → owner, admin
-- live.view_station            → packer
-- ============================================================================
INSERT INTO public.role_permission_matrix (role, permission_code) VALUES
  ('owner', 'packing_station.camera_setup'),
  ('admin', 'packing_station.camera_setup'),
  ('owner', 'live.view_remote'),
  ('admin', 'live.view_remote'),
  ('packer', 'live.view_station')
ON CONFLICT DO NOTHING;
