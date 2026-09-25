-- ============================================================================
-- Khoá tài khoản phải có hiệu lực NGAY, kể cả với phiên đang mở.
--
-- Triệu chứng 2026-09-25: tài khoản `nguyenhagiang@betacom.vn` hiện "disabled"
-- trên giao diện nhưng vẫn đăng nhập vào hệ thống được.
--
-- Gốc: `user_profiles.status` là cột của riêng ứng dụng — Supabase Auth không
-- biết nó tồn tại. Đo trên database thật: status='disabled' nhưng
-- auth.users.banned_until IS NULL, và không chỗ nào trong mã nguồn từng ghi
-- vào banned_until. Nên `signInWithPassword` vẫn cấp token như thường.
--
-- Phần khoá cửa đăng nhập đã xử ở tầng ứng dụng (`ban_duration` qua
-- admin.updateUserById). Còn lại là phiên ĐÃ phát trước đó: GoTrue thu hồi
-- refresh token khi ban, nhưng access token đã cấp vẫn sống tới hết hạn
-- (mặc định 1 giờ) — và 37 route dùng `requirePermission` không-strict đọc vai
-- trò từ chính token đó nên không biết chủ nhân vừa bị khoá.
--
-- Vì sao cần hàm này thay vì xoá thẳng từ ứng dụng: đã đo quyền trên
-- `auth.sessions` — CHỈ vai trò `postgres` có, `service_role` không có gì.
-- Cấp quyền ghi thẳng schema `auth` cho service_role là mở rộng bề mặt tấn
-- công cho mọi đường dùng service key. Hàm SECURITY DEFINER hẹp hơn nhiều:
-- làm đúng một việc, trên đúng một user id.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id must not be null';
  END IF;

  -- `auth.refresh_tokens.user_id` là varchar chứ không phải uuid (đã kiểm
  -- information_schema). So theo text để một giá trị rác trong cột đó không
  -- làm cả lệnh khoá đổ vì lỗi ép kiểu.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text;
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$;

-- Chỉ service_role. `authenticated`/`anon` KHÔNG được gọi: hàm này bỏ qua RLS
-- theo thiết kế, để lộ ra client là cho phép người dùng đá phiên của nhau.
REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO service_role;

COMMENT ON FUNCTION public.revoke_user_sessions(uuid) IS
  'Xoá mọi phiên + refresh token của một user. Gọi khi khoá tài khoản để hiệu lực tức thì thay vì chờ access token hết hạn. Chỉ service_role.';
