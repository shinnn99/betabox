-- ============================================================================
-- CRIT-5 (B1.1): `apply_camera_probes` tenant filter + REVOKE anon/authenticated.
--
-- Bằng chứng B1.1 discovery (MCP prod 2026-07-07):
--   apply_camera_probes(p_probes jsonb) — SECURITY DEFINER
--   execute_grantees = authenticated, anon, service_role, postgres
--   search_path = (null)
--
-- Đây là leak PATH thực: bất kỳ authenticated user browser có thể gọi
-- .rpc('apply_camera_probes', { p_probes: [{id:<foreign uuid>, ...}] })
-- và tampering `cameras.last_probe_*` của tenant khác. Không có RLS
-- (function chạy DEFINER với owner postgres). Không phải chỉ "trust-caller
-- pattern" mà là remote-exploitable.
--
-- Fix:
--   1. Tạo v2 mới `apply_camera_probes_v2(p_organization_id uuid,
--      p_probes jsonb)` — filter cameras.organization_id trong UPDATE.
--      Trả JSON { requested, updated, rejected } để caller alert khi
--      mismatch.
--   2. Set `search_path = public, pg_temp` (chống CVE-2018-1058 tương lai
--      nếu default privileges cho phép CREATE trên public).
--   3. GRANT EXECUTE chỉ service_role. REVOKE khác.
--   4. REVOKE anon + authenticated khỏi v1 ngay lập tức — kể cả nếu
--      route legacy còn dùng, service_role vẫn giữ EXECUTE. Điều này
--      đóng leak PATH mà không phá caller đang xài admin key.
--   5. Đánh dấu v1 DEPRECATED qua COMMENT. Migration riêng sẽ DROP v1
--      sau khi grep-CI xác nhận 0 caller trong repo.
--
-- Idempotent:
--   - CREATE OR REPLACE FUNCTION v2 (an toàn nhiều lần).
--   - REVOKE ... IF EXISTS-like: PostgreSQL REVOKE trên grantee không
--     tồn tại KHÔNG throw, nhưng nếu grantee đã bị revoke thì cũng
--     không lỗi. An toàn để chạy nhiều lần.
--   - COMMENT ON FUNCTION idempotent.
--
-- KHÔNG chạy migration này lên shared DB trong phiên này. Chỉ tạo file
-- + verification script.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. REVOKE anon/authenticated khỏi v1 — đóng leak PATH ngay.
--    service_role vẫn giữ EXECUTE để route legacy (nếu còn) chạy được.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.apply_camera_probes(jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.apply_camera_probes(jsonb) FROM authenticated;
-- Đảm bảo PUBLIC không tồn tại (Supabase default có thể có PUBLIC).
REVOKE EXECUTE ON FUNCTION public.apply_camera_probes(jsonb) FROM PUBLIC;

-- Đánh dấu v1 DEPRECATED.
COMMENT ON FUNCTION public.apply_camera_probes(jsonb) IS
  'DEPRECATED 2026-07-07: use apply_camera_probes_v2(p_organization_id, p_probes). '
  'Sẽ DROP trong migration sau khi grep-CI xác nhận 0 caller. Leak PATH đã '
  'đóng qua REVOKE anon/authenticated trong migration 20260707140100.';

-- ----------------------------------------------------------------------------
-- 2. apply_camera_probes_v2 — tenant filter ở tầng UPDATE
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_camera_probes_v2(
  p_organization_id uuid,
  p_probes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_requested int := 0;
  v_updated int := 0;
BEGIN
  -- Precondition: p_organization_id bắt buộc.
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'apply_camera_probes_v2: p_organization_id required'
      USING ERRCODE = '22004';
  END IF;

  -- Payload validation: array, không rỗng, cap 100.
  IF p_probes IS NULL OR jsonb_typeof(p_probes) <> 'array' THEN
    RAISE EXCEPTION 'apply_camera_probes_v2: p_probes must be jsonb array'
      USING ERRCODE = '22023';
  END IF;
  v_requested := jsonb_array_length(p_probes);
  IF v_requested = 0 THEN
    RETURN jsonb_build_object(
      'requested', 0,
      'updated', 0,
      'rejected', 0
    );
  END IF;
  IF v_requested > 100 THEN
    RAISE EXCEPTION 'apply_camera_probes_v2: too many probes (%; max 100)', v_requested
      USING ERRCODE = '22023';
  END IF;

  WITH probe_data AS (
    SELECT
      (elem->>'id')::uuid AS id,
      (elem->>'last_probe_ok')::boolean AS last_probe_ok,
      NULLIF(elem->>'last_probe_latency_ms', '')::integer AS last_probe_latency_ms,
      (elem->>'probe_consecutive_fails')::integer AS probe_consecutive_fails
    FROM jsonb_array_elements(p_probes) AS elem
  ),
  updated AS (
    UPDATE public.cameras c
    SET
      last_probe_at = now(),
      last_probe_ok = p.last_probe_ok,
      last_probe_latency_ms = p.last_probe_latency_ms,
      probe_consecutive_fails = p.probe_consecutive_fails
    FROM probe_data p
    WHERE c.id = p.id
      -- Tenant filter: chỉ update camera cùng org caller khai. Nếu payload
      -- chứa camera Org B trong khi caller khai Org A → row Org B bị bỏ
      -- qua (không match WHERE), báo về rejected count > 0.
      AND c.organization_id = p_organization_id
    RETURNING c.id
  )
  SELECT count(*) INTO v_updated FROM updated;

  RETURN jsonb_build_object(
    'requested', v_requested,
    'updated', v_updated,
    'rejected', v_requested - v_updated
  );
END;
$$;

COMMENT ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) IS
  'Batch update camera probe state với tenant filter. p_organization_id '
  'BẮT BUỘC — verify caller (agent HMAC) đã resolve từ warehouse_agents. '
  'Trả jsonb {requested, updated, rejected} để caller alert khi mismatch '
  '(dấu hiệu bug caller build payload cross-tenant hoặc tấn công).';

-- ----------------------------------------------------------------------------
-- 3. GRANT chỉ service_role — REVOKE mọi thứ khác.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_camera_probes_v2(uuid, jsonb) TO service_role;

COMMIT;
