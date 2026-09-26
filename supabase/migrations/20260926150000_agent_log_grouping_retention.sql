-- ============================================================================
-- Gom log agent + hạn lưu — `agent_log_events` (kế hoạch VAN-HANH-NHIEU-KHO,
-- đợt 8)
--
-- VÌ SAO: đo 7 ngày ở MỘT kho: 26.990 dòng, 77% nhiễu (`[qr-frame-source]` một
-- mình 20.948). 528 lần FATAL và 525 lần MediaMTX chết nằm im trong đống đó
-- không ai được báo. Năm mươi kho là 1,35 triệu dòng một tuần — bảng không
-- ai mở. Nghiệm thu đợt 8: một kho dưới 2.000 dòng / tuần.
--
-- GOM Ở CLOUD, không chỉ ở agent: agent 0.13.0 đã tự gom câu lặp, nhưng máy
-- kho chạy bản cũ vẫn xả như trước — và năm mươi kho sẽ không lên bản mới
-- cùng một ngày. Route /api/agent/log-events tính `dedupe_key` (câu log đã bỏ
-- số, mã hex, id) và `bucket_start` (khung 60 phút cho warn, 30 phút cho
-- error), rồi gọi `ingest_agent_log_events`: cùng máy, cùng mức, cùng câu,
-- cùng khung → MỘT dòng, `repeat_count` tăng dần.
--
-- Ước lượng trên số đo trên (70 giờ làm việc / tuần): ~10 câu warn thường trực
-- × 70 khung + ~4 câu error × 140 khung ≈ 1.300 dòng / tuần — dưới trần 2.000,
-- trước cả khi agent 0.13.0 gom thêm ở nguồn.
--
-- Dòng cũ (trước migration) có `dedupe_key` NULL — không gom, giữ nguyên, hết
-- hạn theo hạn lưu.
--
-- HẠN LƯU 30 NGÀY bằng pg_cron (đã có sẵn trên production — reaper, dọn
-- nonce), KHÔNG dựa vào timer VPS. Log là kênh CHẨN ĐOÁN, không phải bằng
-- chứng: sự cố có lịch sử ở sổ `warehouse_incidents`.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

ALTER TABLE public.agent_log_events
  ADD COLUMN IF NOT EXISTS repeat_count    integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_emitted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS dedupe_key      text        NULL,
  ADD COLUMN IF NOT EXISTS bucket_start    timestamptz NULL;

ALTER TABLE public.agent_log_events
  DROP CONSTRAINT IF EXISTS agent_log_events_repeat_count_check;
ALTER TABLE public.agent_log_events
  ADD CONSTRAINT agent_log_events_repeat_count_check CHECK (repeat_count >= 1);

-- Một dòng cho mỗi (máy, mức, câu, khung). Chỉ áp cho dòng có khoá gom.
CREATE UNIQUE INDEX IF NOT EXISTS agent_log_events_group_uniq
  ON public.agent_log_events (agent_id, level, dedupe_key, bucket_start)
  WHERE dedupe_key IS NOT NULL;

-- Gộp một lô sự kiện. Mỗi phần tử:
--   { level, message, emitted_at, last_emitted_at, dedupe_key, bucket_start, count }
-- Trùng (máy, mức, câu, khung) thì cộng dồn đếm và dời mốc cuối; câu mẫu giữ
-- câu ĐẦU TIÊN của khung (đủ để đọc; các câu sau chỉ khác số).
--
-- Tự gộp các phần tử trùng khoá TRONG CÙNG lô trước khi ghi: một câu
-- `INSERT … ON CONFLICT DO UPDATE` không được đụng một dòng hai lần — thiếu
-- bước này, lô có hai câu cùng khoá sẽ hỏng cả lô. Route đã gộp sẵn; ở đây
-- gộp lại để hàm đúng với mọi người gọi.
--
-- Phần tử thiếu `dedupe_key` hoặc `bucket_start` ghi thành dòng riêng như
-- trước khi có gom.
CREATE OR REPLACE FUNCTION public.ingest_agent_log_events(
  p_agent_id uuid,
  p_organization_id uuid,
  p_events jsonb
)
RETURNS integer
LANGUAGE sql
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ev AS (
    SELECT
      x.elem->>'level' AS level,
      x.elem->>'message' AS message,
      (x.elem->>'emitted_at')::timestamptz AS emitted_at,
      coalesce(
        (x.elem->>'last_emitted_at')::timestamptz,
        (x.elem->>'emitted_at')::timestamptz
      ) AS last_emitted_at,
      x.elem->>'dedupe_key' AS dedupe_key,
      (x.elem->>'bucket_start')::timestamptz AS bucket_start,
      greatest(1, coalesce((x.elem->>'count')::integer, 1)) AS cnt,
      x.ord
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS x(elem, ord)
    WHERE x.elem->>'level' IN ('warn', 'error')
      AND x.elem->>'message' IS NOT NULL
      AND x.elem->>'emitted_at' IS NOT NULL
  ),
  grouped AS (
    SELECT
      level,
      (array_agg(message ORDER BY emitted_at, ord))[1] AS message,
      min(emitted_at) AS emitted_at,
      max(last_emitted_at) AS last_emitted_at,
      dedupe_key,
      bucket_start,
      sum(cnt)::integer AS cnt
    FROM ev
    WHERE dedupe_key IS NOT NULL AND bucket_start IS NOT NULL
    GROUP BY level, dedupe_key, bucket_start
    UNION ALL
    SELECT level, message, emitted_at, last_emitted_at, NULL, NULL, cnt
    FROM ev
    WHERE dedupe_key IS NULL OR bucket_start IS NULL
  ),
  ins AS (
    INSERT INTO public.agent_log_events AS t (
      agent_id, organization_id, level, message, emitted_at,
      last_emitted_at, dedupe_key, bucket_start, repeat_count
    )
    SELECT
      p_agent_id,
      p_organization_id,
      g.level,
      g.message,
      g.emitted_at,
      g.last_emitted_at,
      g.dedupe_key,
      g.bucket_start,
      g.cnt
    FROM grouped g
    ON CONFLICT (agent_id, level, dedupe_key, bucket_start) WHERE dedupe_key IS NOT NULL
    DO UPDATE SET
      repeat_count = t.repeat_count + excluded.repeat_count,
      last_emitted_at = greatest(
        coalesce(t.last_emitted_at, t.emitted_at),
        coalesce(excluded.last_emitted_at, excluded.emitted_at)
      )
    RETURNING 1
  )
  SELECT count(*)::integer FROM ins;
$function$;

REVOKE ALL ON FUNCTION public.ingest_agent_log_events(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ingest_agent_log_events(uuid, uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_agent_log_events(uuid, uuid, jsonb) TO service_role;

-- Hạn lưu.
CREATE OR REPLACE FUNCTION public.prune_agent_log_events(p_keep_days integer DEFAULT 30)
RETURNS integer
LANGUAGE sql
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH gone AS (
    DELETE FROM public.agent_log_events
    WHERE emitted_at < now() - make_interval(days => greatest(p_keep_days, 1))
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone;
$function$;

REVOKE ALL ON FUNCTION public.prune_agent_log_events(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_agent_log_events(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_agent_log_events(integer) TO service_role;

-- pg_cron: 20:40 UTC = 03:40 giờ Việt Nam, ngoài giờ làm. Lên lịch lại được
-- (bỏ lịch cũ cùng tên trước) — chạy migration hai lần không đẻ hai job.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'prune-agent-log-events';
    PERFORM cron.schedule(
      'prune-agent-log-events',
      '40 20 * * *',
      $CRON$SELECT public.prune_agent_log_events(30);$CRON$
    );
  ELSE
    RAISE NOTICE 'pg_cron chưa cài — hạn lưu agent_log_events sẽ không tự chạy.';
  END IF;
END;
$$;

COMMENT ON COLUMN public.agent_log_events.repeat_count IS
  'Số lần câu này (đã bỏ số / hex / id) lặp lại trong khung bucket_start của cùng máy, cùng mức. 1 = không lặp.';
COMMENT ON COLUMN public.agent_log_events.dedupe_key IS
  'Khoá gom: câu log đã bỏ số, mã hex, id. NULL = dòng trước khi có gom (trước 26/09/2026).';
COMMENT ON COLUMN public.agent_log_events.bucket_start IS
  'Đầu khung gom: 60 phút cho warn, 30 phút cho error.';

COMMIT;
