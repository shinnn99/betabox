-- ============================================================================
-- CHỈ chủ sở hữu được xoá tài khoản người dùng (chủ dự án chốt 23/09/2026)
--
-- Trước đây `user.delete` cấp cho owner + admin + warehouse_manager (đợt
-- phân quyền 22/09/2026: "trưởng kho vẫn phải được thêm sửa xoá người dùng
-- hệ thống có quyền thấp hơn"). Chủ dự án thu lại: xoá tài khoản là thao
-- tác KHÔNG hoàn tác được — xoá là mất sạch hồ sơ khỏi database — nên chỉ
-- một người được cầm.
--
-- Thêm/sửa người dùng KHÔNG đổi: admin và trưởng kho vẫn giữ `user.create`
-- và `user.update` như cũ.
--
-- Route `DELETE /api/users/[id]` còn một chốt nữa: kể cả có mã quyền trong
-- tay, vai trò khác `owner` vẫn bị chặn. Hai lớp vì mất một tài khoản là
-- mất cả lịch sử đăng nhập lẫn quyền của người đó.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

DELETE FROM public.role_permission_matrix
WHERE permission_code = 'user.delete'
  AND role <> 'owner';

-- Chủ sở hữu phải CÓ quyền này (phòng khi ai đó lỡ xoá mất dòng của owner).
INSERT INTO public.role_permission_matrix (role, permission_code)
VALUES ('owner', 'user.delete')
ON CONFLICT DO NOTHING;

COMMIT;
