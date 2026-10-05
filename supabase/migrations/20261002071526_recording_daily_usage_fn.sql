-- ============================================================================
-- RPC gộp dung lượng ghi THEO NGÀY — cho trang /dashboard/storage
--
-- VÌ SAO PHẢI LÀ RPC: bản đầu kéo thẳng `camera_recording_files` về Node rồi
-- gộp bằng JS, kèm ghi chú "đã lọc org + 14 ngày nên tập nhỏ". Ghi chú đó SAI:
-- kho Đại Kim có 11.158 dòng trong 14 ngày. PostgREST chặn ở 1.000 dòng mặc
-- định, nên trang chỉ nhận được 1.000 dòng CŨ NHẤT và vẽ ra đúng 2 ngày — một
-- biểu đồ trông như kho ngừng hoạt động, trong khi kho vẫn chạy đủ 13 ngày.
--
-- Gộp ở SQL trả về tối đa ~31 dòng thay vì hàng chục nghìn, nên vừa đúng vừa
-- nhẹ. Đây cũng là lý do KHÔNG chữa bằng cách nâng `.limit()`: nâng lên 50.000
-- là kéo 50.000 dòng về Node mỗi lần mở trang, và vẫn vỡ khi kho chạy nhiều
-- camera hơn.
--
-- MÚI GIỜ: cắt ngày theo 'Asia/Ho_Chi_Minh'. Cloud chạy TZ=UTC; cắt bằng UTC
-- thì bản ghi 7 giờ sáng của kho rơi nhầm sang ngày hôm trước.
--
-- CÁCH LY TENANT: hàm BẮT BUỘC nhận p_organization_id và mọi WHERE đều lọc
-- cột đó. Không có nhánh nào trả dữ liệu toàn hệ.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.recording_daily_usage(
  p_organization_id uuid,
  p_days integer DEFAULT 14
)
RETURNS TABLE (
  day                    date,
  segments               bigint,
  bytes                  bigint,
  segments_without_size  bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    (f.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day,
    count(*)::bigint,
    -- Đoạn chưa có dung lượng cộng 0, và được ĐẾM RIÊNG ở cột sau để trang
    -- nói được "ngày này thiếu số liệu" thay vì vẽ cột ngắn không giải thích.
    coalesce(sum(f.file_size_bytes), 0)::bigint,
    count(*) FILTER (WHERE f.file_size_bytes IS NULL)::bigint
  FROM public.camera_recording_files f
  WHERE f.organization_id = p_organization_id
    AND f.started_at >= now() - make_interval(days => GREATEST(p_days, 1))
  GROUP BY 1
  ORDER BY 1 DESC;
$$;

COMMENT ON FUNCTION public.recording_daily_usage(uuid, integer) IS
  'Dung lượng + số đoạn ghi theo ngày của một tổ chức, cho trang Dung lượng lưu trữ.';

REVOKE ALL ON FUNCTION public.recording_daily_usage(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recording_daily_usage(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.recording_daily_usage(uuid, integer) TO service_role;

COMMIT;
