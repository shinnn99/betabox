-- ============================================================================
-- RPC báo cáo VẬN HÀNH — bảy hàm gộp cho trang /dashboard/reports bản mới
--
-- VÌ SAO GỘP Ở SQL: trang cũ (lib/reports/service.ts) paginate packing_events
-- 1.000 dòng/lần rồi gộp bằng JS. Trang mới cần thêm bốn nguồn nữa
-- (staff_work_sessions, packing_stations, order_proof_clips,
-- camera_recording_files) — ở kho Đại Kim là 36.810 dòng recording_files. Kéo
-- từng ấy về Node mỗi lần mở trang là không chấp nhận được, và
-- `percentile_cont` thì PostgREST không biểu diễn được.
--
-- VÌ SAO BẢY HÀM CỐ ĐỊNH, KHÔNG MỘT HÀM "CHẠY SQL BẤT KỲ": một RPC nhận chuỗi
-- SQL tuỳ ý chạy SECURITY DEFINER sẽ bỏ qua toàn bộ cách ly tenant — ai gọi
-- được nó đọc được mọi tổ chức. Mỗi hàm dưới đây có câu truy vấn đóng cứng,
-- chỉ nhận p_organization_id + khoảng ngày, và mọi mệnh đề WHERE đều lọc
-- organization_id.
--
-- P50/P90 THAY TRUNG BÌNH: đo ngày 29/09/2026 tại Đại Kim — TB 58s nhưng
-- p50=44s, p90=133s. Trung bình che mất đuôi, mà đuôi mới là thứ quản được.
--
-- capped_timeout ĐẾM RIÊNG, KHÔNG LỌC IM LẶNG: 1.047/3.885 đơn valid (27%)
-- có work_duration_seconds bị ép cứng = max_order_seconds. Loại khỏi p50/p90
-- là đúng (xem PACKING_EVENT_MEASURED_TIMING_STATUSES ở lib/domain-status.ts),
-- nhưng phải trả kèm `measured` để trang nói rõ "đo trên N% số đơn" thay vì
-- để người đọc tưởng con số phủ 100%.
--
-- MÚI GIỜ: mọi bucket-theo-giờ và mọi phép đổi timestamptz → ngày đều đi qua
-- `at time zone 'Asia/Ho_Chi_Minh'`. Cloud chạy TZ=UTC; lấy giờ của process
-- thì đỉnh 9h sáng của kho hiện thành 2h sáng.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tổng + nhịp của một khoảng ngày. Gọi hai lần (kỳ này / kỳ trước) để ra
--    phần trăm thay đổi.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_report_totals(
  p_organization_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  valid bigint,
  duplicated bigint,
  problems bigint,
  capped bigint,
  returns bigint,
  measured bigint,
  p50 double precision,
  p90 double precision,
  avg_s double precision
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    COUNT(*) FILTER (WHERE pe.status = 'valid' AND pe.event_kind = 'outbound')::bigint,
    COUNT(*) FILTER (WHERE pe.status = 'duplicated' AND pe.event_kind = 'outbound')::bigint,
    COUNT(*) FILTER (WHERE pe.event_kind = 'outbound'
                       AND pe.status NOT IN ('valid','duplicated'))::bigint,
    COUNT(*) FILTER (WHERE pe.event_kind = 'outbound'
                       AND pe.timing_status = 'capped_timeout')::bigint,
    COUNT(*) FILTER (WHERE pe.event_kind = 'return'
                       AND pe.status IN ('valid','return_suspect'))::bigint,
    COUNT(*) FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid'
                       AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout'))::bigint,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
      FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid'
                AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')),
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
      FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid'
                AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')),
    AVG(pe.work_duration_seconds)
      FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid'
                AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout'))
  FROM public.packing_events pe
  WHERE pe.organization_id = p_organization_id
    AND pe.business_date BETWEEN p_from AND p_to;
$$;

-- ---------------------------------------------------------------------------
-- 2. Một dòng mỗi ngày lịch — generate_series để ngày KHÔNG có lượt quét nào
--    vẫn có dòng. Đường biểu đồ nhảy cóc qua ngày nghỉ thì không ai thấy được
--    hôm nào kho đứt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_report_daily(
  p_organization_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  business_date date,
  valid bigint,
  duplicated bigint,
  problems bigint,
  capped bigint,
  returns bigint,
  measured bigint,
  p50 double precision,
  p90 double precision,
  first_scan_at timestamptz,
  last_scan_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH d AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS business_date
  )
  SELECT
    d.business_date,
    COUNT(pe.id) FILTER (WHERE pe.status = 'valid' AND pe.event_kind = 'outbound')::bigint,
    COUNT(pe.id) FILTER (WHERE pe.status = 'duplicated' AND pe.event_kind = 'outbound')::bigint,
    COUNT(pe.id) FILTER (WHERE pe.event_kind = 'outbound'
                           AND pe.status NOT IN ('valid','duplicated'))::bigint,
    COUNT(pe.id) FILTER (WHERE pe.event_kind = 'outbound'
                           AND pe.timing_status = 'capped_timeout')::bigint,
    COUNT(pe.id) FILTER (WHERE pe.event_kind = 'return'
                           AND pe.status IN ('valid','return_suspect'))::bigint,
    COUNT(pe.id) FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid'
                           AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout'))::bigint,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
      FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid'
                AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')),
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
      FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid'
                AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')),
    MIN(pe.scanned_at) FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid'),
    MAX(pe.scanned_at) FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid')
  FROM d
  LEFT JOIN public.packing_events pe
    ON pe.business_date = d.business_date
   AND pe.organization_id = p_organization_id
  GROUP BY d.business_date
  ORDER BY d.business_date;
$$;

-- ---------------------------------------------------------------------------
-- 3. "Một ngày ở kho" — đơn theo giờ VN, kèm giờ ghi hình phủ khung giờ đó.
--    LEFT JOIN từ bảng 0..23 nên giờ có ghi hình mà không có đơn (và ngược
--    lại) đều hiện ra — đúng chỗ cần nhìn: camera có chạy lúc kho làm không.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_report_hourly(
  p_organization_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  hour integer,
  outbound bigint,
  returns bigint,
  recording_hours double precision
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH h AS (SELECT generate_series(0, 23) AS hour),
  scans AS (
    SELECT
      EXTRACT(HOUR FROM pe.scanned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour,
      COUNT(*) FILTER (WHERE pe.event_kind = 'outbound' AND pe.status = 'valid')::bigint AS outbound,
      COUNT(*) FILTER (WHERE pe.event_kind = 'return'
                         AND pe.status IN ('valid','return_suspect'))::bigint AS returns
    FROM public.packing_events pe
    WHERE pe.organization_id = p_organization_id
      AND pe.business_date BETWEEN p_from AND p_to
    GROUP BY 1
  ),
  rec AS (
    SELECT
      EXTRACT(HOUR FROM f.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour,
      SUM(COALESCE(f.duration_seconds, 0)) / 3600.0 AS recording_hours
    FROM public.camera_recording_files f
    WHERE f.organization_id = p_organization_id
      AND (f.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN p_from AND p_to
    GROUP BY 1
  )
  SELECT
    h.hour,
    COALESCE(scans.outbound, 0)::bigint,
    COALESCE(scans.returns, 0)::bigint,
    COALESCE(rec.recording_hours, 0)::double precision
  FROM h
  LEFT JOIN scans ON scans.hour = h.hour
  LEFT JOIN rec ON rec.hour = h.hour
  ORDER BY h.hour;
$$;

-- ---------------------------------------------------------------------------
-- 4. Theo bàn đóng hàng.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_report_stations(
  p_organization_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  station_id uuid,
  station_name text,
  valid bigint,
  capped bigint,
  measured bigint,
  p50 double precision,
  p90 double precision,
  avg_s double precision
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    pe.station_id,
    COALESCE(ps.name, 'Chưa gán bàn') AS station_name,
    COUNT(*) FILTER (WHERE pe.status = 'valid')::bigint,
    COUNT(*) FILTER (WHERE pe.timing_status = 'capped_timeout')::bigint,
    COUNT(*) FILTER (WHERE pe.status = 'valid'
                       AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout'))::bigint,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
      FILTER (WHERE pe.status = 'valid'
                AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')),
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
      FILTER (WHERE pe.status = 'valid'
                AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')),
    AVG(pe.work_duration_seconds)
      FILTER (WHERE pe.status = 'valid'
                AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout'))
  FROM public.packing_events pe
  LEFT JOIN public.packing_stations ps ON ps.id = pe.station_id
  WHERE pe.organization_id = p_organization_id
    AND pe.business_date BETWEEN p_from AND p_to
    AND pe.event_kind = 'outbound'
  GROUP BY pe.station_id, ps.name
  HAVING COUNT(*) FILTER (WHERE pe.status = 'valid') > 0
  ORDER BY 3 DESC;
$$;

-- ---------------------------------------------------------------------------
-- 5. Theo nhân sự — năng suất tính trên GIỜ CÓ MẶT THẬT (staff_work_sessions),
--    không phải "đơn / ngày".
--
--    staff_work_sessions gộp ở CTE riêng trước khi join. Join thẳng vào
--    packing_events sẽ nhân chéo một phiên với từng đơn của phiên đó và thổi
--    giờ làm lên gấp số đơn.
--
--    Phiên còn đang mở (ended_at NULL) tính tới now() — ca đang chạy vẫn phải
--    có mẫu số, nếu không nhân viên đang làm sẽ hiện năng suất vô cực.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_report_staff(
  p_organization_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  staff_id uuid,
  full_name text,
  valid bigint,
  duplicated bigint,
  capped bigint,
  active_days bigint,
  measured bigint,
  p50 double precision,
  p90 double precision,
  avg_s double precision,
  worked_hours double precision,
  stale_sessions bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH ev AS (
    SELECT
      pe.staff_id,
      COUNT(*) FILTER (WHERE pe.status = 'valid')::bigint AS valid,
      COUNT(*) FILTER (WHERE pe.status = 'duplicated')::bigint AS duplicated,
      COUNT(*) FILTER (WHERE pe.timing_status = 'capped_timeout')::bigint AS capped,
      COUNT(DISTINCT pe.business_date) FILTER (WHERE pe.status = 'valid')::bigint AS active_days,
      COUNT(*) FILTER (WHERE pe.status = 'valid'
                         AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout'))::bigint AS measured,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
        FILTER (WHERE pe.status = 'valid'
                  AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')) AS p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
        FILTER (WHERE pe.status = 'valid'
                  AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')) AS p90,
      AVG(pe.work_duration_seconds)
        FILTER (WHERE pe.status = 'valid'
                  AND pe.timing_status IN ('finalized_by_next_scan','finalized_by_checkout')) AS avg_s
    FROM public.packing_events pe
    WHERE pe.organization_id = p_organization_id
      AND pe.business_date BETWEEN p_from AND p_to
      AND pe.event_kind = 'outbound'
    GROUP BY pe.staff_id
  ),
  sess AS (
    SELECT
      s.staff_id,
      SUM(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.started_at))) / 3600.0 AS worked_hours,
      COUNT(*) FILTER (WHERE s.end_reason = 'auto_closed_stale')::bigint AS stale_sessions
    FROM public.staff_work_sessions s
    WHERE s.organization_id = p_organization_id
      AND (s.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN p_from AND p_to
    GROUP BY s.staff_id
  )
  SELECT
    ev.staff_id,
    COALESCE(sp.full_name,
             CASE WHEN ev.staff_id IS NULL THEN 'Chưa xác định' ELSE '—' END) AS full_name,
    ev.valid, ev.duplicated, ev.capped, ev.active_days, ev.measured,
    ev.p50, ev.p90, ev.avg_s,
    COALESCE(sess.worked_hours, 0)::double precision,
    COALESCE(sess.stale_sessions, 0)::bigint
  FROM ev
  LEFT JOIN public.staff_profiles sp ON sp.id = ev.staff_id
  LEFT JOIN sess ON sess.staff_id IS NOT DISTINCT FROM ev.staff_id
  WHERE ev.valid > 0 OR ev.duplicated > 0
  ORDER BY ev.valid DESC;
$$;

-- ---------------------------------------------------------------------------
-- 5b. Theo nhân sự — LUỒNG HOÀN, truy vấn RIÊNG.
--
--     Kiện hoàn KHÔNG trộn vào sản lượng đóng hàng (chủ dự án chốt
--     23/09/2026): gộp vào là sai cả số đơn lẫn nhịp của nhân viên. Hàm này
--     trả đúng bộ cột của ops_report_staff để một khung bảng vẽ được cả hai
--     luồng, không đẻ ra hai bộ số chực lệch nhau.
--
--     'return_suspect' (lưới an toàn ở bàn đóng hàng) LÀ kiện hoàn thật;
--     'duplicated_return' là quét lại, không phải kiện mới. Lượt quét hỏng
--     (chưa vào ca / máy quét chưa gán / mã sai) bỏ hẳn — cùng quy tắc với
--     normalizeReturnRows ở lib/reports/service.ts.
--
--     CÓ p50/p90 và capped: luồng hoàn có cấu trúc Y HỆT đóng hàng, chỉ khác
--     tên trường —
--         close_reason='timeout'     ~ timing_status='capped_timeout'
--         close_reason='next_scan'   ~ finalized_by_next_scan
--         close_reason='mode_switch' ~ finalized_by_mode_switch
--     Đo Đại Kim 30/09/2026: 11/34 kiện đóng vì timeout, CẢ 11 đều đúng 300s
--     (trần cấu hình). Gộp nhóm đó vào thì p90 = 300s = đúng trần, vô nghĩa;
--     loại ra thì p50=121s, p90=201s — số đo thật. Cùng nguyên tắc với
--     PACKING_EVENT_MEASURED_TIMING_STATUSES ở lib/domain-status.ts.
--
--     KHÔNG có worked_hours: nhân viên vào ca MỘT lần rồi vừa đóng hàng vừa
--     nhận hoàn, nên giờ làm là chung cho cả hai luồng, không quy riêng được.
--
--     DROP trước CREATE: bản đầu của hàm này (cùng ngày) trả 5 cột, mà
--     Postgres không cho CREATE OR REPLACE đổi kiểu trả về. Không DROP thì
--     migration chạy lại trên máy đã có bản cũ sẽ lỗi 42P13.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.ops_report_return_staff(uuid, date, date);

CREATE OR REPLACE FUNCTION public.ops_report_return_staff(
  p_organization_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  staff_id uuid,
  full_name text,
  valid bigint,
  duplicated bigint,
  active_days bigint,
  capped bigint,
  measured bigint,
  p50 double precision,
  p90 double precision
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH ev AS (
    SELECT
      pe.staff_id,
      COUNT(*) FILTER (WHERE pe.status IN ('valid','return_suspect'))::bigint AS valid,
      COUNT(*) FILTER (WHERE pe.status = 'duplicated_return')::bigint AS duplicated,
      COUNT(DISTINCT pe.business_date)
        FILTER (WHERE pe.status IN ('valid','return_suspect'))::bigint AS active_days,
      COUNT(*) FILTER (WHERE pe.timing_status = 'return_closed'
                         AND pe.close_reason = 'timeout')::bigint AS capped,
      COUNT(*) FILTER (WHERE pe.timing_status = 'return_closed'
                         AND pe.close_reason IS DISTINCT FROM 'timeout'
                         AND pe.work_duration_seconds IS NOT NULL)::bigint AS measured,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
        FILTER (WHERE pe.timing_status = 'return_closed'
                  AND pe.close_reason IS DISTINCT FROM 'timeout') AS p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY pe.work_duration_seconds)
        FILTER (WHERE pe.timing_status = 'return_closed'
                  AND pe.close_reason IS DISTINCT FROM 'timeout') AS p90
    FROM public.packing_events pe
    WHERE pe.organization_id = p_organization_id
      AND pe.business_date BETWEEN p_from AND p_to
      AND pe.event_kind = 'return'
    GROUP BY pe.staff_id
  )
  SELECT
    ev.staff_id,
    COALESCE(sp.full_name,
             CASE WHEN ev.staff_id IS NULL THEN 'Chưa xác định' ELSE '—' END),
    ev.valid, ev.duplicated, ev.active_days, ev.capped, ev.measured, ev.p50, ev.p90
  FROM ev
  LEFT JOIN public.staff_profiles sp ON sp.id = ev.staff_id
  WHERE ev.valid > 0 OR ev.duplicated > 0
  ORDER BY ev.valid DESC;
$$;

-- ---------------------------------------------------------------------------
-- 6. Sức khoẻ bằng chứng — ghi hình còn chạy không, clip có dùng được không,
--    khiếu nại hoàn còn mở bao nhiêu.
--
--    `days_without_recording` đếm ngày TRONG KHOẢNG không có một file nào.
--    Đây là chỉ số đứt ghi hình: sự cố Đại Kim 28/08 (ghi hình chết 8 ngày,
--    79 đơn mất bằng chứng) đáng lẽ hiện ngay ở ô này.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_report_evidence(
  p_organization_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  last_recording_date date,
  recording_hours_last_day double precision,
  days_without_recording bigint,
  clips_ready bigint,
  clips_failed bigint,
  clips_evicted bigint,
  clips_pending bigint,
  open_claims bigint,
  overdue_claims bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH last_day AS (
    SELECT MAX((f.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS d
    FROM public.camera_recording_files f
    WHERE f.organization_id = p_organization_id
  )
  SELECT
    (SELECT d FROM last_day),
    (SELECT SUM(COALESCE(f.duration_seconds, 0)) / 3600.0
       FROM public.camera_recording_files f
      WHERE f.organization_id = p_organization_id
        AND (f.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (SELECT d FROM last_day)
    )::double precision,
    (SELECT COUNT(*) FROM generate_series(p_from, p_to, interval '1 day') g
      WHERE NOT EXISTS (
        SELECT 1 FROM public.camera_recording_files f
         WHERE f.organization_id = p_organization_id
           AND (f.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = g::date)
    )::bigint,
    (SELECT COUNT(*) FROM public.order_proof_clips c
      WHERE c.organization_id = p_organization_id AND c.status = 'ready'
        AND (c.clip_started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN p_from AND p_to)::bigint,
    (SELECT COUNT(*) FROM public.order_proof_clips c
      WHERE c.organization_id = p_organization_id AND c.status = 'failed'
        AND (c.clip_started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN p_from AND p_to)::bigint,
    (SELECT COUNT(*) FROM public.order_proof_clips c
      WHERE c.organization_id = p_organization_id AND c.status = 'evicted'
        AND (c.clip_started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN p_from AND p_to)::bigint,
    (SELECT COUNT(*) FROM public.order_proof_clips c
      WHERE c.organization_id = p_organization_id AND c.status = 'pending'
        AND (c.clip_started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN p_from AND p_to)::bigint,
    (SELECT COUNT(*) FROM public.return_claims rc
      WHERE rc.organization_id = p_organization_id AND rc.status = 'open')::bigint,
    (SELECT COUNT(*) FROM public.return_claims rc
      WHERE rc.organization_id = p_organization_id AND rc.status = 'open'
        AND rc.deadline_at IS NOT NULL AND rc.deadline_at < now())::bigint;
$$;

-- ---------------------------------------------------------------------------
-- Quyền: chỉ service_role. Route /api/reports/operations đã gác bằng
-- requirePermission('report.view') và truyền organizationId của phiên — không
-- mở cho authenticated để client không tự chọn org khác.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'ops_report_totals', 'ops_report_daily', 'ops_report_hourly',
    'ops_report_stations', 'ops_report_staff', 'ops_report_return_staff',
    'ops_report_evidence'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(uuid, date, date) FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(uuid, date, date) FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(uuid, date, date) FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(uuid, date, date) TO service_role', fn);
  END LOOP;
END $$;

COMMENT ON FUNCTION public.ops_report_totals(uuid, date, date) IS
  'Tổng + p50/p90 nhịp đóng hàng của một khoảng. Trả kèm `measured` làm mẫu số '
  '— mọi số thời gian phải hiển thị kèm "đo trên N% số đơn".';
COMMENT ON FUNCTION public.ops_report_daily(uuid, date, date) IS
  'Một dòng mỗi ngày lịch kể cả ngày trống (generate_series), để thấy ngày đứt.';
COMMENT ON FUNCTION public.ops_report_hourly(uuid, date, date) IS
  'Đơn theo giờ VN + giờ ghi hình phủ khung giờ đó. Bucket theo Asia/Ho_Chi_Minh.';
COMMENT ON FUNCTION public.ops_report_stations(uuid, date, date) IS
  'Sản lượng, tỉ lệ capped và p50/p90 theo bàn đóng hàng.';
COMMENT ON FUNCTION public.ops_report_staff(uuid, date, date) IS
  'Theo nhân sự. worked_hours từ staff_work_sessions (gộp ở CTE riêng để không '
  'nhân chéo phiên × đơn); phiên đang mở tính tới now().';
COMMENT ON FUNCTION public.ops_report_return_staff(uuid, date, date) IS
  'Theo nhân sự cho LUỒNG HOÀN, truy vấn riêng — kiện hoàn không trộn vào sản '
  'lượng đóng hàng (chốt 23/09/2026).';
COMMENT ON FUNCTION public.ops_report_evidence(uuid, date, date) IS
  'Sức khoẻ bằng chứng: ngày ghi hình gần nhất, số ngày đứt ghi, clip theo '
  'trạng thái, khiếu nại hoàn đang mở/quá hạn.';

COMMIT;
