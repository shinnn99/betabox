-- Lát 2 SaaS: agent local TCP-connect RTSP port của camera mỗi 30s,
-- batch report qua /api/agent/camera-probe. UI đọc để phân biệt Online
-- / Offline / Mất kết nối kho / Đã cấu hình.
--
-- Ba cột heartbeat/probe của Betacom, đừng lẫn:
--   - warehouse_agents.last_seen_at (agent còn sống, 60s ngưỡng)
--   - camera_recording_sessions.last_heartbeat_at (session đang ghi, 90s)
--   - cameras.last_probe_at (camera nghe RTSP port, 90s)
ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS last_probe_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_probe_ok boolean,
  ADD COLUMN IF NOT EXISTS last_probe_latency_ms integer;

-- Debounce N-nhịp-fail-liên-tiếp mới đổi Offline (chống flicker Online↔
-- Offline khi mạng kho jitter). Đếm ở DB vì agent stateless (restart
-- mất RAM); DB là nguồn chân lý sống.
ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS probe_consecutive_fails integer NOT NULL DEFAULT 0;

-- Batch update N probe trong 1 round-trip (thay N update tuần tự).
-- Nhận JSON array [{id, last_probe_ok, last_probe_latency_ms,
-- probe_consecutive_fails}]. last_probe_at set = now() server-side
-- (an toàn hơn client timestamp). Multi-tenant filter ở caller (route
-- đã filter allowed trước khi gọi RPC) — RPC không tự filter org.
CREATE OR REPLACE FUNCTION apply_camera_probes(p_probes jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH probe_data AS (
    SELECT
      (elem->>'id')::uuid AS id,
      (elem->>'last_probe_ok')::boolean AS last_probe_ok,
      NULLIF(elem->>'last_probe_latency_ms', '')::integer AS last_probe_latency_ms,
      (elem->>'probe_consecutive_fails')::integer AS probe_consecutive_fails
    FROM jsonb_array_elements(p_probes) AS elem
  ),
  updated AS (
    UPDATE cameras c
    SET
      last_probe_at = now(),
      last_probe_ok = p.last_probe_ok,
      last_probe_latency_ms = p.last_probe_latency_ms,
      probe_consecutive_fails = p.probe_consecutive_fails
    FROM probe_data p
    WHERE c.id = p.id
    RETURNING c.id
  )
  SELECT count(*) INTO updated_count FROM updated;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_camera_probes(jsonb) TO service_role;
