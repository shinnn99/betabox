-- Lát 3a-2 followup: cho phép clip_path/clip_name/clip_started_at/
-- clip_ended_at là null khi status='failed'.
--
-- Trước: NOT NULL toàn bộ → agent báo failed (segments_missing) bị
-- backend từ chối insert (500) vì clip chưa được tạo, chưa có
-- path/name/started/ended thật. Kết quả: bảng thiếu row failed, ops
-- không track được các lần cắt hỏng.
--
-- Sau: nullable. Row failed vẫn insert được với null ở các cột clip
-- thật. Constraint clip_period_ordered là CHECK (a > b) — với NULL
-- trả UNKNOWN nên không violated.
--
-- Note: khi status='ready' agent phải gửi đủ path/name/started/ended,
-- backend không kiểm tường minh nhưng logic hiển thị UI sẽ.

alter table public.order_proof_clips alter column clip_path drop not null;
alter table public.order_proof_clips alter column clip_name drop not null;
alter table public.order_proof_clips alter column clip_started_at drop not null;
alter table public.order_proof_clips alter column clip_ended_at drop not null;
