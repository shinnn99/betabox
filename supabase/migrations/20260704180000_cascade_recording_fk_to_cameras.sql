-- Đổi FK 2 bảng recording (sessions + files) sang ON DELETE CASCADE khi
-- xoá camera. Lý do: recording liên tục 24/7 là dữ liệu vận hành, không
-- có giá trị pháp lý — xoá camera thì xoá luôn lịch sử recording tự động.
--
-- GIỮ NGUYÊN RESTRICT cho order_proof_clips.camera_id: clip pháp lý gắn
-- với đơn hàng cụ thể, không được cascade-xoá theo camera. Khi camera
-- còn clip pháp lý → deleteCamera phải throw 23503, UI phải soft-delete
-- (chuyển camera sang inactive) thay vì hard-delete.

ALTER TABLE public.camera_recording_sessions
  DROP CONSTRAINT IF EXISTS camera_recording_sessions_camera_id_fkey;
ALTER TABLE public.camera_recording_sessions
  ADD CONSTRAINT camera_recording_sessions_camera_id_fkey
  FOREIGN KEY (camera_id) REFERENCES public.cameras(id) ON DELETE CASCADE;

ALTER TABLE public.camera_recording_files
  DROP CONSTRAINT IF EXISTS camera_recording_files_camera_id_fkey;
ALTER TABLE public.camera_recording_files
  ADD CONSTRAINT camera_recording_files_camera_id_fkey
  FOREIGN KEY (camera_id) REFERENCES public.cameras(id) ON DELETE CASCADE;

DO $$
DECLARE
  bad_rule_count int;
BEGIN
  SELECT COUNT(*) INTO bad_rule_count
  FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON tc.constraint_name = rc.constraint_name
  WHERE tc.table_schema = 'public'
    AND tc.table_name IN ('camera_recording_sessions', 'camera_recording_files')
    AND tc.constraint_name IN (
      'camera_recording_sessions_camera_id_fkey',
      'camera_recording_files_camera_id_fkey'
    )
    AND rc.delete_rule <> 'CASCADE';

  IF bad_rule_count > 0 THEN
    RAISE EXCEPTION 'cascade_recording_fk: % constraint(s) not CASCADE', bad_rule_count;
  END IF;
END $$;
