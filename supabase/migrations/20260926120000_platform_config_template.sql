-- ============================================================================
-- Mẫu cấu hình nền tảng — `platform_config_template`
-- (kế hoạch VAN-HANH-NHIEU-KHO, đợt 6)
--
-- VÌ SAO CẦN: lệnh tạo tổ chức chỉ ghi {name, slug}, tạo kho chỉ ghi mã/tên/
-- địa chỉ. Tổ chức mới ra đời với hạn lưu video TRỐNG — agent không nhận
-- hạn lưu, script dọn ổ máy kho fail-loud rồi không chạy, ổ đầy dần.
--
-- CHÉP LÚC TẠO, KHÔNG PHỦ LÚC ĐỌC. Giá trị mẫu được chép vào tổ chức / kho
-- lúc tạo. Mẫu KHÔNG phải tầng đọc chồng: nếu là tầng đọc chồng thì sửa mẫu
-- sẽ âm thầm đổi cấu hình của mọi tổ chức chưa đặt, kể cả kho đang chạy. Áp
-- mẫu cho tổ chức có sẵn là thao tác CÓ NGƯỜI BẤM ("điền vào ô trống"), có
-- audit, không bao giờ ghi đè ô đã đặt.
--
-- MỘT NGOẠI LỆ ĐỌC LÚC CHẠY: `clip_max_seconds` — trần kỹ thuật độ dài
-- clip bằng chứng, đồng thời là trần tự dừng đơn đi (hai con số phải bằng
-- nhau: đơn mở lâu hơn clip là khoảng không có video). Đây là lan can của
-- cả nền tảng, không phải cấu hình của tổ chức.
--
--   Vì sao trần 210: clip ghép hai góc được nén lại ở agent với bitrate cố
--   định 3200 kbps, giới hạn tải lên 90 MiB. 90 MiB × 8 / 3,2 Mbps ≈ 235 s;
--   chừa 10% cho dao động bitrate và vỏ MP4 → 210 s. Vượt nữa thì clip cắt
--   xong bị agent TỪ CHỐI tải lên — clip cụt thành không có clip. Nới trần
--   này chỉ sau khi agent tự hạ bitrate cho clip dài (đợt 7).
--
-- GIÁ TRỊ BAN ĐẦU = ĐÚNG MẶC ĐỊNH ĐANG CHẠY TRONG MÃ — chạy migration này
-- không đổi hành vi của kho nào. `retention_days` không có mặc định trong mã
-- (trống = không dọn); 30 là giá trị cả hai tổ chức hiện có đang dùng.
--
-- Chỉ service role chạm được (RLS bật, không policy) — sửa qua API platform,
-- có audit.
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.platform_config_template (
  -- Bảng một dòng.
  id                          smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Tổ chức — cùng khoảng với route tenant (src/lib/config/validate.ts).
  retention_days              integer     NOT NULL DEFAULT 30  CHECK (retention_days BETWEEN 7 AND 365),
  return_retention_days       integer     NOT NULL DEFAULT 7   CHECK (return_retention_days BETWEEN 7 AND 365),

  -- Kho.
  max_order_seconds           integer     NOT NULL DEFAULT 180 CHECK (max_order_seconds BETWEEN 60 AND 3600),
  video_pre_seconds           integer     NOT NULL DEFAULT 5   CHECK (video_pre_seconds BETWEEN 0 AND 120),
  video_default_post_seconds  integer     NOT NULL DEFAULT 60  CHECK (video_default_post_seconds BETWEEN 1 AND 600),
  session_fallback_seconds    integer     NOT NULL DEFAULT 30  CHECK (session_fallback_seconds > 0),

  -- Lan can nền tảng, đọc lúc chạy. Xem ghi chú đầu file.
  clip_max_seconds            integer     NOT NULL DEFAULT 180 CHECK (clip_max_seconds BETWEEN 60 AND 210),

  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NULL
);

INSERT INTO public.platform_config_template (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_config_template ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.platform_config_template IS
  'Mẫu cấu hình nền tảng (một dòng). Chép vào tổ chức / kho LÚC TẠO, không đọc chồng về sau. Riêng clip_max_seconds là lan can đọc lúc chạy. Không policy RLS — chỉ service role.';
COMMENT ON COLUMN public.platform_config_template.clip_max_seconds IS
  'Trần độ dài clip bằng chứng = trần tự dừng đơn đi. Tối đa 210 vì clip nén 3200 kbps phải vừa ngưỡng tải lên 90 MiB của agent.';

COMMIT;
