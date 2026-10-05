-- ============================================================================
-- RPC đọc dung lượng bucket video — cho trang /platform/storage
--
-- VÌ SAO CẦN HÀM: schema `storage` không nằm trong danh sách schema PostgREST
-- lộ ra, nên client không `.from("storage.objects")` được. Muốn đọc kích thước
-- thật của từng file phải đi qua một hàm SECURITY DEFINER.
--
-- VÌ SAO ĐỌC `storage.objects` CHỨ KHÔNG CỘNG `order_proof_clips.clip_size_bytes`:
-- hai nguồn KHÔNG khớp. Đo 02/10/2026: bucket có 34 object / 1421 MB, bảng clip
-- chỉ nhận 31 / 1354 MB — 3 object mồ côi, 67 MB, không dòng clip nào trỏ tới.
-- Cộng theo bảng clip thì con số LUÔN nhỏ hơn thực tế, và đúng phần chênh đó
-- là thứ làm hoá đơn Supabase cao hơn ước lượng mà không ai giải thích được.
--
-- VÌ SAO AN TOÀN DÙ LÀ SECURITY DEFINER: hàm KHÔNG nhận SQL tuỳ ý, chỉ nhận
-- tên bucket + trần số dòng. Nó trả đúng ba cột (đường dẫn, kích thước, ngày
-- tạo) — không trả nội dung file, không trả signed URL, không cho ghi. Quyền
-- EXECUTE chỉ cấp cho `service_role`: đường gọi duy nhất là route platform đã
-- qua `requirePlatformRole`. KHÔNG cấp cho `authenticated` — cấp là mọi user
-- tenant đọc được đường dẫn clip của MỌI kho, tức rò rỉ chéo tổ chức.
--
-- `search_path` ghim cứng: hàm SECURITY DEFINER không ghim search_path có thể
-- bị dụ gọi nhầm hàm/bảng cùng tên từ schema khác.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.storage_usage_objects(
  p_bucket text,
  p_limit  integer DEFAULT 2000
)
RETURNS TABLE (
  name       text,
  size_bytes bigint,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = storage, pg_catalog
AS $$
  SELECT
    o.name,
    -- metadata->>'size' là text; file đang upload dở có thể thiếu khoá này,
    -- nên COALESCE về 0 thay vì để NULL làm hỏng phép cộng ở tầng trên.
    COALESCE((o.metadata ->> 'size')::bigint, 0) AS size_bytes,
    o.created_at
  FROM storage.objects o
  WHERE o.bucket_id = p_bucket
  -- Lớn nhất trước: chạm trần p_limit thì phần bị cắt là phần nhẹ nhất,
  -- và tổng hiện ra vẫn gần đúng nhất có thể.
  ORDER BY COALESCE((o.metadata ->> 'size')::bigint, 0) DESC
  LIMIT GREATEST(p_limit, 0);
$$;

COMMENT ON FUNCTION public.storage_usage_objects(text, integer) IS
  'Dung lượng từng file trong một bucket Storage, cho trang Dung lượng video của platform. Chỉ service_role gọi được.';

-- Thu hồi quyền mặc định rồi cấp lại đúng một vai: PostgreSQL mặc định cấp
-- EXECUTE cho PUBLIC khi tạo hàm.
REVOKE ALL ON FUNCTION public.storage_usage_objects(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.storage_usage_objects(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.storage_usage_objects(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.storage_usage_objects(text, integer) TO service_role;

COMMIT;
