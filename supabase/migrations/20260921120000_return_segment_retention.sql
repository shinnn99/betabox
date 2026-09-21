-- ============================================================================
-- Hàng hoàn — Đợt 4: hạn lưu 7 ngày cho segment thuần hàng hoàn
--
-- Kế hoạch: plans/active/HOAN-HANG-quay-video-don-hoan.md (mục 4 và đợt 4)
--
-- Segment là đoạn video 60 giây camera ghi liên tục, KHÔNG phải video của
-- một đơn. Cùng một segment có thể chứa cả đoạn đóng hàng lẫn đoạn mở kiện
-- hoàn. Vì vậy chỉ rút hạn lưu xuống 7 ngày cho segment nào chắc chắn chỉ
-- phục vụ hàng hoàn; nghi ngờ thì giữ theo `retention_days` của tổ chức.
--
-- Ba điều kiện (phải đủ cả ba):
--   (a) segment nằm TRỌN trong một kỳ NHẬN HOÀN của bàn mà camera đang gắn;
--   (b) không giao với cửa sổ video của bất kỳ ĐƠN ĐI nào dùng camera đó;
--   (c) camera chỉ phục vụ đúng một bàn trong khoảng thời gian của segment.
--
-- Thà giữ lâu còn hơn xoá sớm bằng chứng đơn đi.
-- ============================================================================

BEGIN;

ALTER TABLE public.camera_recording_files
  ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'default';

ALTER TABLE public.camera_recording_files DROP CONSTRAINT IF EXISTS camera_recording_files_retention_class_check;
ALTER TABLE public.camera_recording_files
  ADD CONSTRAINT camera_recording_files_retention_class_check
    CHECK (retention_class IN ('default', 'return_short'));

COMMENT ON COLUMN public.camera_recording_files.retention_class IS
  'default = giữ theo retention_days của tổ chức. return_short = segment thuần hàng hoàn, giữ 7 ngày (đợt 4 hàng hoàn).';

-- Agent hỏi danh sách file cần xoá sớm theo cột này.
CREATE INDEX IF NOT EXISTS camera_recording_files_return_short_idx
  ON public.camera_recording_files (organization_id, started_at)
  WHERE retention_class = 'return_short';

-- ---------------------------------------------------------------------------
-- Phân loại
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.classify_return_segments(
  p_organization_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH candidate AS (
    SELECT f.id, f.camera_id, f.started_at, f.ended_at
    FROM public.camera_recording_files f
    WHERE f.organization_id = p_organization_id
      AND f.retention_class = 'default'
      AND f.started_at IS NOT NULL
      AND f.ended_at IS NOT NULL
      -- Segment phải đóng hẳn: file đang ghi thì chưa biết nó chứa gì.
      AND f.ended_at < p_now - interval '10 minutes'
      -- Không cần xét segment đã quá hạn chung; nó sẽ bị xoá theo đường cũ.
      AND f.started_at > p_now - interval '30 days'
  ),
  -- Bàn mà camera phục vụ trong đúng khoảng thời gian của segment.
  station_of AS (
    SELECT c.id, sda.station_id
    FROM candidate c
    JOIN public.station_devices sd
      ON sd.device_type = 'camera'
     AND sd.config_json->>'camera_id' = c.camera_id::text
    JOIN public.station_device_assignments sda
      ON sda.device_id = sd.id
     AND sda.assigned_at < c.ended_at
     AND COALESCE(sda.unassigned_at, 'infinity'::timestamptz) > c.started_at
  ),
  -- (c) Chỉ đúng một bàn trong khoảng đó.
  single_station AS (
    -- Postgres không có min(uuid); ép về text để lấy đại diện, đằng nào
    -- HAVING cũng chỉ giữ nhóm có đúng một bàn.
    SELECT id, (min(station_id::text))::uuid AS station_id
    FROM station_of
    GROUP BY id
    HAVING count(DISTINCT station_id) = 1
  ),
  -- (a) Nằm trọn trong một kỳ NHẬN HOÀN của bàn đó.
  in_return_mode AS (
    SELECT s.id, s.station_id
    FROM single_station s
    JOIN candidate c ON c.id = s.id
    WHERE EXISTS (
      SELECT 1
      FROM public.station_mode_periods smp
      WHERE smp.station_id = s.station_id
        AND smp.mode = 'return'
        AND smp.started_at <= c.started_at
        AND COALESCE(smp.ended_at, 'infinity'::timestamptz) >= c.ended_at
    )
  ),
  -- (b) Không giao với cửa sổ video của bất kỳ đơn đi nào dùng camera này.
  safe AS (
    SELECT r.id
    FROM in_return_mode r
    JOIN candidate c ON c.id = r.id
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.packing_events pe
      WHERE pe.organization_id = p_organization_id
        AND pe.event_kind = 'outbound'
        AND (pe.proof_camera_id = c.camera_id OR pe.proof_qr_camera_id = c.camera_id)
        -- Nới hai đầu 60 giây cho pre-roll / post-roll của clip.
        AND (COALESCE(pe.work_started_at, pe.scanned_at) - interval '60 seconds') < c.ended_at
        AND (COALESCE(pe.work_ended_at, p_now) + interval '60 seconds') > c.started_at
    )
  )
  UPDATE public.camera_recording_files f
    SET retention_class = 'return_short'
    FROM safe
    WHERE f.id = safe.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.classify_return_segments(uuid, timestamptz) IS
  'Đánh dấu segment thuần hàng hoàn để agent xoá sau 7 ngày. Ba điều kiện an toàn; nghi ngờ thì giữ nguyên.';

REVOKE ALL ON FUNCTION public.classify_return_segments(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

COMMIT;
