-- ============================================================================
-- RPC lark_digest_per_staff — aggregate đơn theo nhân sự trong khoảng [from, to)
-- cho 1 warehouse. Dùng bởi Edge Function `lark-digest` để build tin digest.
--
-- Đầu ra mỗi row = 1 nhân sự có ít nhất 1 event trong window:
--   staff_id, staff_code, full_name,
--   total       — tổng đơn (valid + duplicated) — "số đơn đã xử lý"
--   duplicated  — status='duplicated'
--   no_active_session, unmapped_scanner, invalid_code
--   manual_error — count đơn có manual_error=true (đánh dấu lỗi thủ công)
--   issues_total = duplicated + no_active_session + unmapped_scanner
--                + invalid_code + manual_error
--
-- Bao gồm cả staff_id NULL (đơn không assign được nhân sự — no_active_session
-- / unmapped_scanner). Row đó có staff_code=NULL, full_name='(chưa assign)'.
--
-- Sort: issues_total DESC (nhân sự lỗi nhiều nhất lên đầu → digest hiển
-- thị top).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.lark_digest_per_staff(
  p_warehouse_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  staff_id uuid,
  staff_code text,
  full_name text,
  total bigint,
  duplicated bigint,
  no_active_session bigint,
  unmapped_scanner bigint,
  invalid_code bigint,
  manual_error bigint,
  issues_total bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH agg AS (
    SELECT
      pe.staff_id,
      COUNT(*) FILTER (WHERE pe.status IN ('valid','duplicated'))::bigint AS total,
      COUNT(*) FILTER (WHERE pe.status = 'duplicated')::bigint AS duplicated,
      COUNT(*) FILTER (WHERE pe.status = 'no_active_session')::bigint AS no_active_session,
      COUNT(*) FILTER (WHERE pe.status = 'unmapped_scanner')::bigint AS unmapped_scanner,
      COUNT(*) FILTER (WHERE pe.status = 'invalid_code')::bigint AS invalid_code,
      COUNT(*) FILTER (WHERE pe.manual_error = true)::bigint AS manual_error
    FROM public.packing_events pe
    WHERE pe.warehouse_id = p_warehouse_id
      AND pe.scanned_at >= p_from
      AND pe.scanned_at < p_to
    GROUP BY pe.staff_id
  )
  SELECT
    agg.staff_id,
    sp.staff_code,
    COALESCE(sp.full_name, '(chưa assign)') AS full_name,
    agg.total,
    agg.duplicated,
    agg.no_active_session,
    agg.unmapped_scanner,
    agg.invalid_code,
    agg.manual_error,
    (agg.duplicated + agg.no_active_session + agg.unmapped_scanner
      + agg.invalid_code + agg.manual_error) AS issues_total
  FROM agg
  LEFT JOIN public.staff_profiles sp ON sp.id = agg.staff_id
  ORDER BY issues_total DESC, total DESC;
$$;

COMMENT ON FUNCTION public.lark_digest_per_staff(uuid, timestamptz, timestamptz) IS
  'Aggregate packing_events per staff trong window [from, to) cho 1 kho. '
  'Dùng bởi Edge Function lark-digest. Sort issues_total DESC.';

REVOKE ALL ON FUNCTION public.lark_digest_per_staff(uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lark_digest_per_staff(uuid, timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.lark_digest_per_staff(uuid, timestamptz, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lark_digest_per_staff(uuid, timestamptz, timestamptz) TO service_role;
