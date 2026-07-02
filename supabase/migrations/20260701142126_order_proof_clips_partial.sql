-- Lát 3a-2: thêm thuộc tính "clip có gap khoảng nào".
--
-- is_partial: clip có ít nhất một gap trong khoảng target — mắt người
-- xem có thể thấy nội dung nhảy đột ngột. status vẫn 'ready' vì clip
-- cắt xong, phát được — tách vòng đời (status) khỏi thuộc tính nội
-- dung (is_partial).
--
-- covered_range: khoảng thực tế có video, tstzrange native để dùng
-- được operator @> (chứa), && (giao), và index GiST nếu về sau cần.
-- Không dùng jsonb vì mọi truy vấn "clip nào phủ khoảng này" sẽ phải
-- parse tay.
--
-- BLOCKS-GO-LIVE (rủi ro pháp lý, cắm cọc trong clip-cutter.ts):
-- clip partial nối thẳng qua gap lớn (VD 14 phút) trông liền mạch,
-- có thể bị coi là cắt ghép giấu diếm khi ra sàn/tranh chấp. Trước
-- go-live: quyết cách xử (chèn màn đen+text / từ chối / burn-in
-- timestamp) và enforce. is_partial + covered_range CHỈ là dữ liệu
-- báo về đủ để cloud quyết — 3a-2 KHÔNG tự chặn.

alter table public.order_proof_clips
  add column is_partial boolean not null default false;

alter table public.order_proof_clips
  add column covered_range tstzrange;
