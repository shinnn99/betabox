-- Lát 2: chặn typo type ở tầng DB.
--
-- Lát 1 để type text tự do vì "chưa biết type sau này có gì" — kết quả
-- là mọi typo (start_recordng, stop_reording...) sẽ lặng lẽ thành job
-- không handler nào nhận, nằm chết trong bảng. Với 3 type sắp có và
-- sẽ thêm cut_clip ở Lát 3, thêm CHECK rẻ hơn dò typo về sau.
--
-- Constraint đặt tên rõ để Lát 3 (thêm cut_clip) grep được: drop + add
-- lại với danh sách mới.

alter table public.agent_commands
  add constraint agent_commands_type_check
  check (type in ('ping', 'start_recording', 'stop_recording'));
