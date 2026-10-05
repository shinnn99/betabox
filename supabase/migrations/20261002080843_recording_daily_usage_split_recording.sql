-- ============================================================================
-- Tách "đoạn ĐANG QUAY" khỏi "đoạn thiếu dung lượng vĩnh viễn"
--
-- VÌ SAO: bản `20261002071526` đếm chung mọi đoạn có `file_size_bytes IS NULL`
-- rồi gán nhãn "máy kho bản cũ". Nhưng đoạn ĐANG QUAY (`ended_at IS NULL`) cũng
-- chưa có dung lượng — vài phút nữa đóng file là có, hoàn toàn bình thường.
--
-- Gộp hai thứ đó làm NGÀY HÔM NAY lúc nào cũng bị gắn nhãn "máy kho bản cũ" chỉ
-- vì có 1-2 đoạn đang quay. Một lời cảnh báo sai mỗi ngày, và cảnh báo sai lặp
-- lại là cách nhanh nhất để người dùng thôi đọc cảnh báo.
--
-- Số đo 02/10/2026 chứng minh đúng là hai ca khác nhau:
--   * 18, 19, 21/09 — thiếu ~50% mỗi ngày, đều đã đóng file → agent bản cũ,
--     dữ liệu sẽ KHÔNG BAO GIỜ có.
--   * 02/10         — chỉ 2/778 đoạn, cả hai `ended_at IS NULL`, bắt đầu chưa
--     tới 1 phút trước → đang quay, không phải thiếu sót.
--
-- DROP trước vì thêm cột trả về = đổi kiểu trả về của hàm (42P13).
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.recording_daily_usage(uuid, integer);

CREATE FUNCTION public.recording_daily_usage(
  p_organization_id uuid,
  p_days integer DEFAULT 14
)
RETURNS TABLE (
  day                    date,
  segments               bigint,
  bytes                  bigint,
  segments_without_size  bigint,
  segments_recording     bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    (f.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day,
    count(*)::bigint,
    coalesce(sum(f.file_size_bytes), 0)::bigint,
    -- Đã đóng file mà vẫn không có dung lượng → sẽ không bao giờ có.
    count(*) FILTER (
      WHERE f.file_size_bytes IS NULL AND f.ended_at IS NOT NULL
    )::bigint,
    -- Đang quay dở — chưa có dung lượng là ĐÚNG, không phải thiếu sót.
    count(*) FILTER (
      WHERE f.file_size_bytes IS NULL AND f.ended_at IS NULL
    )::bigint
  FROM public.camera_recording_files f
  WHERE f.organization_id = p_organization_id
    AND f.started_at >= now() - make_interval(days => GREATEST(p_days, 1))
  GROUP BY 1
  ORDER BY 1 DESC;
$$;

COMMENT ON FUNCTION public.recording_daily_usage(uuid, integer) IS
  'Dung lượng + số đoạn ghi theo ngày của một tổ chức. Tách đoạn đang quay khỏi đoạn thiếu dung lượng vĩnh viễn.';

REVOKE ALL ON FUNCTION public.recording_daily_usage(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recording_daily_usage(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.recording_daily_usage(uuid, integer) TO service_role;

COMMIT;
