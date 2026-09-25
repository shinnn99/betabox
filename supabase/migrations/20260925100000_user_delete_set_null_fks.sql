-- ============================================================================
-- Xoá người dùng hệ thống bị chặn bởi 2 khoá ngoại NO ACTION
--
-- Triệu chứng 2026-09-25: bấm Xoá ở trang Người dùng hệ thống hiện toast đỏ
-- rỗng "{}". Nguyên nhân: admin.auth.admin.deleteUser() xoá dòng auth.users,
-- nhưng hai bảng dưới trỏ vào auth.users với NO ACTION nên Postgres chặn:
--
--   camera_recording_sessions.created_by   (3 tài khoản vướng: 7 / 5 / 1 phiên)
--   order_proof_clips.generated_by         (0 dòng hiện tại, nhưng cùng bẫy)
--
-- Mọi khoá ngoại KHÁC trỏ vào auth.users đã là SET NULL hoặc CASCADE
-- (audit_logs, staff_profiles, return_claims, order_proof_requests...).
-- Hai bảng này là ngoại lệ sót lại, không phải chủ ý giữ vết.
--
-- Quyết định (chủ dự án chốt 25/09/2026): đổi sang SET NULL.
--   - Phiên ghi hình và clip bằng chứng GIỮ NGUYÊN — không mất dữ liệu nghiệp vụ.
--   - Chỉ mất thông tin "ai đã bật", đúng mức đánh đổi mà audit_logs đã chọn.
--   - audit_logs vẫn lưu action user.delete kèm full_name + role của người bị xoá,
--     nên vết "ai bị xoá, ai xoá" không mất.
--
-- Cột đã nullable sẵn (kiểm tra trước khi viết migration) nên không cần ALTER COLUMN.
-- ============================================================================

ALTER TABLE public.camera_recording_sessions
  DROP CONSTRAINT IF EXISTS camera_recording_sessions_created_by_fkey;

ALTER TABLE public.camera_recording_sessions
  ADD CONSTRAINT camera_recording_sessions_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.order_proof_clips
  DROP CONSTRAINT IF EXISTS order_proof_clips_generated_by_fkey;

ALTER TABLE public.order_proof_clips
  ADD CONSTRAINT order_proof_clips_generated_by_fkey
  FOREIGN KEY (generated_by) REFERENCES auth.users (id) ON DELETE SET NULL;
