-- ============================================================================
-- Bỏ bản cũ 4 tham số của release_return_capture
--
-- `CREATE OR REPLACE FUNCTION` chỉ thay khi TRÙNG danh sách tham số. Thêm
-- `p_force` ở 20260924100000 nên PostgreSQL tạo thêm một bản mới bên cạnh
-- bản cũ, chứ không thay. Từ đó mọi lời gọi 4 tham số đều hỏng:
--
--   Could not choose the best candidate function between:
--     release_return_capture(p_station_id, p_holder, p_reason, p_at),
--     release_return_capture(p_station_id, p_holder, p_reason, p_at, p_force)
--
-- Tức là tắt phiên hoàn THƯỜNG (không ép) chết hẳn — đúng cái vừa đi sửa.
-- Đo được ngay trên database: bật xong, gọi tắt 4 tham số trả lỗi trên, bàn
-- vẫn ở chế độ hoàn.
--
-- Bỏ bản cũ đi, chỉ còn một bản duy nhất. Mã nguồn luôn truyền `p_force`
-- nên khớp đúng bản còn lại.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.release_return_capture(uuid, text, text, timestamptz);

COMMIT;
