-- ============================================================================
-- CRIT-6 (B1.1): enqueue_clip_generation verify camera + agent thuộc org.
--
-- Bối cảnh (B1.1 discovery MCP prod 2026-07-07):
--   Function hiện tại (migration 20260706100100_safe_retry_pending_uniq_and_enqueue_rpc):
--     - SECURITY DEFINER + search_path=public,pg_temp — OK.
--     - EXECUTE chỉ service_role — OK.
--     - Verify packing_event thuộc p_organization_id — OK.
--     - THIẾU: verify camera thuộc p_organization_id.
--     - THIẾU: verify agent thuộc p_organization_id.
--
-- Root cause: nếu caller (admin client) build sai args (VD dùng pe_id
-- Org A + camera_id Org B + agent_id Org C), RPC vẫn INSERT
-- order_proof_clips(org=A, camera_id=B, ...) và agent_commands(org=A,
-- agent_id=C, payload chứa clip_id thuộc A). Kết quả: agent Org C nhận
-- job có clip_id Org A → cắt clip trên camera Org B nếu segments đã có →
-- upload lên bucket Org A.
--
-- Fix: CREATE OR REPLACE cùng signature — thêm 2 PERFORM 1 verify + raise
-- exception explicit code. Không đổi output row shape → caller không cần
-- update.
--
-- Warehouse relation: MCP xác nhận chỉ packing_events có warehouse_id;
-- cameras và warehouse_agents chưa có FK trực tiếp (Betacom hiện 1
-- warehouse/org — chưa multi-warehouse). Không thêm warehouse relation
-- check trong B1.1 — sẽ đưa vào B2 khi mở đa-warehouse.
--
-- Idempotent: CREATE OR REPLACE FUNCTION. Grant/revoke đã có ở
-- migration gốc — không lặp lại.
--
-- KHÔNG chạy migration này lên shared DB trong phiên này. Chỉ tạo file
-- + verification script.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.enqueue_clip_generation(
  p_organization_id uuid,
  p_packing_event_id uuid,
  p_camera_id uuid,
  p_waybill_code text,
  p_agent_id uuid,
  p_clip_started_at timestamptz,
  p_clip_ended_at timestamptz,
  p_is_partial boolean,
  p_source_files jsonb,
  p_generation_params jsonb,
  p_command_payload jsonb
)
RETURNS TABLE(clip_id uuid, command_id uuid, result_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clip_id uuid;
  v_command_id uuid;
  v_existing_pending public.order_proof_clips%rowtype;
  v_existing_command_id uuid;
  v_final_payload jsonb;
BEGIN
  -- Sanity: mọi input required.
  IF p_organization_id IS NULL OR p_packing_event_id IS NULL
     OR p_camera_id IS NULL OR p_agent_id IS NULL
     OR p_waybill_code IS NULL OR p_command_payload IS NULL THEN
    RAISE EXCEPTION 'enqueue_invalid_args' USING ERRCODE = 'P0001';
  END IF;

  -- Cross-tenant guard 1: packing_event thuộc org caller.
  PERFORM 1 FROM public.packing_events
    WHERE id = p_packing_event_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_pe_not_in_org' USING ERRCODE = 'P0001';
  END IF;

  -- CRIT-6 guard 2: camera thuộc org caller.
  -- Không được insert order_proof_clips.camera_id = camera Org B khi
  -- order_proof_clips.organization_id = A.
  PERFORM 1 FROM public.cameras
    WHERE id = p_camera_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_camera_not_in_org' USING ERRCODE = 'P0001';
  END IF;

  -- CRIT-6 guard 3: agent thuộc org caller.
  -- Không được insert agent_commands.agent_id = agent Org C khi
  -- agent_commands.organization_id = A. Agent Org C sẽ poll và nhận
  -- job có clip_id Org A → cross-tenant execute.
  PERFORM 1 FROM public.warehouse_agents
    WHERE id = p_agent_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_agent_not_in_org' USING ERRCODE = 'P0001';
  END IF;

  -- ------------------------------------------------------------------------
  -- Reuse existing pending nếu có (giữ nguyên logic Safe Retry H4).
  -- ------------------------------------------------------------------------
  SELECT * INTO v_existing_pending
  FROM public.order_proof_clips
  WHERE packing_event_id = p_packing_event_id
    AND status = 'pending'
  LIMIT 1;

  IF FOUND THEN
    SELECT id INTO v_existing_command_id
    FROM public.agent_commands
    WHERE type = 'cut_clip'
      AND organization_id = p_organization_id
      AND status IN ('pending', 'taken')
      AND (payload->>'clip_id')::uuid = v_existing_pending.id
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_existing_command_id IS NULL THEN
      RAISE EXCEPTION 'enqueue_stale_pending_without_active_command: clip_id=%',
        v_existing_pending.id USING ERRCODE = 'P0001';
    END IF;

    DECLARE
      v_old_replaces text;
      v_new_replaces text;
    BEGIN
      SELECT payload->>'replaces_clip_id' INTO v_old_replaces
      FROM public.agent_commands WHERE id = v_existing_command_id;
      v_new_replaces := p_command_payload->>'replaces_clip_id';

      IF coalesce(v_old_replaces, '') <> coalesce(v_new_replaces, '') THEN
        RAISE EXCEPTION 'enqueue_pending_replaces_mismatch: existing=% requested=%',
          coalesce(v_old_replaces, 'null'),
          coalesce(v_new_replaces, 'null') USING ERRCODE = 'P0001';
      END IF;
    END;

    RETURN QUERY
      SELECT v_existing_pending.id,
             v_existing_command_id,
             'reused_existing_pending'::text;
    RETURN;
  END IF;

  -- ------------------------------------------------------------------------
  -- Tạo mới: INSERT pending row + INSERT agent_commands.
  -- ------------------------------------------------------------------------
  INSERT INTO public.order_proof_clips(
    organization_id, packing_event_id, camera_id, waybill_code,
    status, cut_mode,
    source_files, generation_params,
    clip_started_at, clip_ended_at, is_partial
  )
  VALUES (
    p_organization_id, p_packing_event_id, p_camera_id, p_waybill_code,
    'pending', 'copy',
    p_source_files, p_generation_params,
    p_clip_started_at, p_clip_ended_at, p_is_partial
  )
  RETURNING id INTO v_clip_id;

  v_final_payload := p_command_payload || jsonb_build_object('clip_id', v_clip_id::text);

  INSERT INTO public.agent_commands(organization_id, agent_id, type, payload)
  VALUES (p_organization_id, p_agent_id, 'cut_clip', v_final_payload)
  RETURNING id INTO v_command_id;

  RETURN QUERY SELECT v_clip_id, v_command_id, 'created'::text;
END;
$function$;

COMMENT ON FUNCTION public.enqueue_clip_generation(
  uuid, uuid, uuid, text, uuid,
  timestamptz, timestamptz, boolean,
  jsonb, jsonb, jsonb
) IS
'Safe-retry H4 + CRIT-6 verify: atomic INSERT order_proof_clips(pending) + '
'agent_commands(cut_clip). Verify packing_event, camera VÀ agent cùng '
'p_organization_id trước INSERT. Reuse pending nếu đã có. '
'ERRCODE P0001: enqueue_pe_not_in_org | enqueue_camera_not_in_org | '
'enqueue_agent_not_in_org | enqueue_stale_pending_without_active_command | '
'enqueue_pending_replaces_mismatch | enqueue_invalid_args.';

-- Grant/revoke giữ nguyên từ migration 20260706100100 — CREATE OR REPLACE
-- không đổi ACL. Không cần lặp REVOKE PUBLIC/anon/authenticated + GRANT
-- service_role vì Postgres giữ ACL cũ khi REPLACE.

COMMIT;
