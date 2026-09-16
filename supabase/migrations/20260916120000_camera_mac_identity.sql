-- E.1 Bước A — định danh camera bằng MAC thay vì bằng IP.
--
-- Vì sao cần:
--   Toàn hệ thống đang nhận dạng camera bằng `cameras.ip`. DHCP cấp lại
--   IP là mất camera, và không có cách nào tự phát hiện. Sự cố 16/09 tại
--   kho Đại Kim: camera bị đổi/tắt, agent nhận danh sách rỗng, ngừng ghi,
--   không ai biết cho tới khi có người mở dashboard.
--
--   MAC là định danh duy nhất ổn định trong LAN. IP tụt xuống thành "địa
--   chỉ hiện tại", có thể thay đổi và được cập nhật tự động.
--
-- Vì sao unique theo (organization_id, mac_address):
--   Hai kho khác nhau có thể trùng MAC (thiết bị luân chuyển, hoặc MAC
--   giả). Unique toàn cục sẽ chặn nhầm. Unique trong org đủ để bảo đảm
--   "một MAC = một camera" ở phạm vi vận hành thật, và chính nó là hàng
--   rào chống ghi đè chéo khi agent báo IP mới.

ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS mac_address text,
  ADD COLUMN IF NOT EXISTS onvif_uuid text,
  ADD COLUMN IF NOT EXISTS ip_last_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ip_auto_healed_count integer NOT NULL DEFAULT 0;

-- Chuẩn hoá cứng ở tầng DB: chữ HOA, ngăn bằng dấu hai chấm. Agent và
-- cloud đều normalize trước khi ghi, constraint này là lưới cuối để một
-- format khác (gạch ngang, chữ thường) không lọt vào và phá so khớp.
ALTER TABLE public.cameras DROP CONSTRAINT IF EXISTS cameras_mac_address_format_check;
ALTER TABLE public.cameras
  ADD CONSTRAINT cameras_mac_address_format_check
  CHECK (mac_address IS NULL OR mac_address ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$');

CREATE UNIQUE INDEX IF NOT EXISTS cameras_org_mac_unique_idx
  ON public.cameras (organization_id, mac_address)
  WHERE mac_address IS NOT NULL;

COMMENT ON COLUMN public.cameras.mac_address IS
  'MAC chuẩn hoá AA:BB:CC:DD:EE:FF. Định danh ổn định của camera; IP chỉ là địa chỉ hiện tại.';
COMMENT ON COLUMN public.cameras.onvif_uuid IS
  'urn:uuid từ ONVIF WS-Discovery. Dự phòng khi không lấy được MAC (camera qua router).';
COMMENT ON COLUMN public.cameras.ip_auto_healed_count IS
  'Số lần IP được tự dò lại theo MAC. Cao = nên đặt DHCP reservation trên router.';

-- Lịch sử địa chỉ của camera.
--
-- Vì sao cần bảng riêng, không chỉ ghi đè cột ip:
--   Clip bằng chứng giao cho khách phải trả lời được "quay từ thiết bị
--   nào". Nếu IP bị ghi đè không dấu vết thì một tháng sau không ai dựng
--   lại được. Bảng này là nhật ký append-only cho việc đó.
CREATE TABLE IF NOT EXISTS public.camera_endpoint_history (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  camera_id uuid NOT NULL REFERENCES public.cameras(id) ON DELETE CASCADE,
  ip text NOT NULL,
  mac_address text,
  -- 'manual'   → admin sửa trên UI
  -- 'discovery'→ chọn thiết bị từ kết quả quét LAN
  -- 'auto_heal'→ agent tự dò lại theo MAC sau khi probe hỏng
  source text NOT NULL CHECK (source IN ('manual', 'discovery', 'auto_heal')),
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS camera_endpoint_history_camera_time_idx
  ON public.camera_endpoint_history (camera_id, observed_at DESC);

COMMENT ON TABLE public.camera_endpoint_history IS
  'Nhật ký IP của camera theo thời gian. Append-only, phục vụ đối soát clip bằng chứng.';

-- KHÔNG policy = default-deny với authenticated; service_role bypass.
-- Giống agent_log_events: chỉ backend đọc/ghi, UI đi qua API route.
ALTER TABLE public.camera_endpoint_history ENABLE ROW LEVEL SECURITY;
