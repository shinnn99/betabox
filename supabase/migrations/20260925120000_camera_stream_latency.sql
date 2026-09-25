-- ============================================================================
-- Độ trễ luồng theo từng camera (kho Đại Kim 25/09/2026)
--
-- Chủ dự án báo: camera toàn cảnh luôn chậm hơn camera QR khoảng 1 giây.
--
-- Vì sao 1 giây đó làm lệch clip bằng chứng:
--
--   Máy kho đặt tên đoạn video theo ĐỒNG HỒ MÁY lúc ghi (`-strftime`), và
--   mốc quét cũng là đồng hồ máy lúc giải mã xong khung hình QR
--   (`qr-frame-source.ts`). Không chỗ nào biết giờ camera CHỤP được cảnh.
--
--   Gọi T là lúc việc xảy ra thật, Lq và Lo là độ trễ của camera QR và
--   camera toàn cảnh. Đoạn video ghi tại vị trí X trên trục đồng hồ máy
--   chứa cảnh của X − L.
--
--     mốc quét   = T + Lq            (giải mã từ camera QR)
--     clip QR    : đọc tại T + Lq → ra cảnh T          ĐÚNG
--     clip toàn cảnh: đọc tại T + Lq → ra cảnh T − (Lo − Lq) = T − 1 giây
--
--   Tức góc QR đang đúng sẵn; chỉ góc toàn cảnh chiếu cảnh của 1 giây
--   trước. Muốn đúng thì phải đọc camera toàn cảnh MUỘN HƠN 1 giây trên
--   trục đồng hồ máy.
--
-- Cột này là con số đó, theo từng camera:
--   > 0  camera về CHẬM hơn mốc quét → dịch cửa sổ cắt MUỘN lại
--   = 0  không hiệu chỉnh (mặc định — camera chưa ai đo)
--   < 0  camera về SỚM hơn mốc quét
--
-- Vì sao để 0 làm mặc định chứ không đoán một con số: 0 là "chưa hiệu
-- chỉnh", đúng sự thật. Đoán bừa thì camera nào cũng lệch một ít mà không
-- ai biết con số ở đâu ra.
--
-- Khoảng ±5 giây: quá ngưỡng đó thì không còn là độ trễ luồng nữa mà là
-- đồng hồ sai hoặc nghẽn mạng — phải sửa gốc, không phải bù.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS stream_latency_ms INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cameras_stream_latency_ms_range'
  ) THEN
    ALTER TABLE public.cameras
      ADD CONSTRAINT cameras_stream_latency_ms_range
      CHECK (stream_latency_ms BETWEEN -5000 AND 5000);
  END IF;
END $$;

COMMENT ON COLUMN public.cameras.stream_latency_ms IS
  'Độ trễ luồng của camera này so với mốc quét, mili giây. Dương = camera về chậm hơn, cửa sổ cắt clip dịch muộn lại đúng ngần ấy. 0 = chưa hiệu chỉnh. Đo bằng cách đặt đồng hồ bấm giờ hiện mili giây trước cả hai camera rồi chụp màn hình hai luồng trực tiếp.';

COMMIT;
