-- Phạm vi theo dõi hạ tầng + giờ vận hành kho.
--
-- Vì sao (hai lỗi THẬT, không phải phòng xa):
--
--   1. Ngày 12/08/2026 mục kiểm `agent_heartbeat` báo crit trong khi kho
--      Đại Kim đang ghi hình bình thường. Thủ phạm: agent DEMO
--      `AGENT_KHO_HN_01` chạy trên máy dev Betacom, nằm chung bảng
--      `warehouse_agents` với agent production và bị tính vào sức khoẻ
--      chung. Cảnh báo production bật/tắt theo việc ai đó gập laptop là
--      cảnh báo sẽ bị phớt lờ sau đúng hai tuần.
--
--   2. Kho Đại Kim tắt máy sau ca. Đo trên `camera_recording_files` 15
--      ngày vận hành (24/07→12/08/2026): segment đầu ngày rơi vào
--      08:21–10:31, segment cuối 16:22–18:31, cả 3 Chủ nhật (26/07,
--      02/08, 09/08) không có segment nào. Ngưỡng cũ "im > 120 phút =
--      crit" đo bằng tuổi thô của last_seen_at sẽ bắn tin Lark mỗi tối,
--      365 đêm/năm. Bật timer 15 phút với ngưỡng đó là tự dạy người trực
--      tắt thông báo.
--
-- Không hard-code kho nào vào code: cả hai thứ đều là cột cấu hình, thêm
-- khách mới hay đổi ca làm đều là một câu UPDATE.

-- ── 1. Org nào được tính vào sức khoẻ production ──────────────────────
ALTER TABLE public.organizations
  ADD COLUMN monitoring_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.monitoring_enabled IS
  'Org này có được tính vào các mục kiểm hạ tầng (/api/system/check) và '
  'cảnh báo Lark hạ tầng không. Mặc định true — khách mới phải được theo '
  'dõi ngay, quên bật là mù. Đặt false cho org demo/nội bộ/đang onboard.';

-- Org demo Betacom: agent chạy trên máy dev, tắt bật theo giờ làm việc
-- của người dựng hệ. Không phải production.
UPDATE public.organizations
  SET monitoring_enabled = false
  WHERE id = '00000000-0000-0000-0000-000000000001';

-- ── 2. Giờ vận hành từng kho ──────────────────────────────────────────
ALTER TABLE public.warehouses
  ADD COLUMN operating_hours JSONB;

COMMENT ON COLUMN public.warehouses.operating_hours IS
  'Khung giờ BẮT BUỘC agent phải sống, dùng cho mục kiểm agent_heartbeat/'
  'camera_probe. Dạng {"timezone":"Asia/Bangkok","start":"09:30",'
  '"end":"16:00","days":[1,2,3,4,5,6]} với days theo ISO (1=T2..7=CN). '
  'NULL = theo dõi 24/7 (mặc định an toàn cho kho chưa khai báo). Đây KHÔNG '
  'phải giờ mở cửa của kho — nó hẹp hơn có chủ đích, xem ghi chú migration.';

-- Kho Đại Kim. Vì sao 09:30–16:00 chứ không phải 08:00–18:00 (giờ mở cửa
-- thật): mục kiểm đo phần im lặng NẰM TRONG khung này, nên hai mép khung
-- phải nằm gọn bên trong khoảng mà 15/15 ngày đo được đều đang chạy.
--   * Mở cửa muộn nhất quan sát được (bỏ 2 ngày lắp đặt): 09:20 (29/07).
--     Khung mở 09:30 → không có buổi sáng nào bị tính oan.
--   * Đóng sớm nhất quan sát được: 16:22 (01/08). Khung đóng 16:00 →
--     không có buổi chiều nào bị tính oan.
--   * Khung 08:00–18:00 sẽ warn 6/6 sáng gần nhất và crit ngày 29/07.
-- Đánh đổi đã biết: sự cố xảy ra trong 08:00–09:30 hoặc 16:00–18:00 phải
-- chờ tới khung sau mới báo. Nới ra được bất cứ lúc nào bằng một UPDATE,
-- nhưng nới trước khi có dữ liệu là mua báo động giả.
UPDATE public.warehouses
  SET operating_hours = '{
    "timezone": "Asia/Bangkok",
    "start": "09:30",
    "end": "16:00",
    "days": [1, 2, 3, 4, 5, 6]
  }'::jsonb
  WHERE id = 'fd7cccaa-23bd-4d28-8bcc-b88bf18e73bc';

-- ── 3. Dọn số đếm chết của camera đã tắt ──────────────────────────────
-- `hik_01` chuyển inactive ngày 05/08 nhưng `probe_consecutive_fails`
-- đứng hình ở 7452 (≈62 giờ lỗi quy đổi). Không gây sự cố — mục
-- camera_probe đã lọc theo status='active' — nhưng bất kỳ ai đọc bảng
-- hoặc viết truy vấn chẩn đoán sau này đều sẽ hiểu nhầm. Số liệu chết
-- phải dọn tại gốc, đồng thời updateCamera() từ nay tự reset khi tắt
-- camera (src/lib/camera/service.ts).
UPDATE public.cameras
  SET probe_consecutive_fails = 0
  WHERE status <> 'active' AND probe_consecutive_fails > 0;
