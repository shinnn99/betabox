-- Ma trận RBAC chỉnh từ Platform + chính sách trang theo ảnh chốt 30/09/2026.
-- Nguồn quyền hiệu lực vẫn là role_permission_matrix; UI Platform không tạo
-- một hệ quyền song song. Hàm replace bên dưới thay toàn bộ ma trận + ghi audit
-- trong CÙNG transaction để không có trạng thái "đã đổi nhưng không có log".

BEGIN;

-- Tách Bảng điều khiển khỏi Báo cáo hiệu suất. Trước đây cả hai dùng
-- report.view nên không thể cho packer/viewer xem dashboard mà cấm báo cáo.
INSERT INTO public.role_permission_matrix (role, permission_code) VALUES
  ('owner', 'dashboard.view'),
  ('admin', 'dashboard.view'),
  ('warehouse_manager', 'dashboard.view'),
  ('shift_leader', 'dashboard.view'),
  ('packer', 'dashboard.view'),
  ('viewer', 'dashboard.view')
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_all text[];
  v_code text;
  v_role text;
  v_manager text[] := ARRAY[
    'dashboard.view',
    'warehouse.view', 'organization.view',
    'order_proof.view', 'video.view', 'video.download',
    'camera.view', 'camera.recording.view', 'live.view_remote',
    'packing_station.view',
    'station_device.view', 'station_device_assignment.view',
    'staff.view', 'report.view',
    'user.view', 'user.create', 'user.update', 'user.delete'
  ];
  v_packer text[] := ARRAY[
    'dashboard.view', 'warehouse.view',
    'order_proof.view', 'video.view', 'video.download',
    'camera.view', 'camera.recording.view', 'live.view_station'
  ];
  v_viewer text[] := ARRAY[
    'dashboard.view', 'warehouse.view',
    'order_proof.view', 'video.view', 'video.download',
    'camera.view', 'camera.recording.view', 'live.view_remote'
  ];
BEGIN
  SELECT array_agg(DISTINCT permission_code ORDER BY permission_code)
    INTO v_all
  FROM public.role_permission_matrix;

  IF v_all IS NULL OR array_length(v_all, 1) < 20 THEN
    RAISE EXCEPTION 'role_permission_matrix co qua it ma quyen: dung migration';
  END IF;

  -- Hai vai trò quản trị luôn full quyền.
  FOREACH v_role IN ARRAY ARRAY['owner', 'admin'] LOOP
    FOREACH v_code IN ARRAY v_all LOOP
      EXECUTE format(
        'INSERT INTO public.role_permission_matrix (role, permission_code) VALUES (%L, %L) ON CONFLICT DO NOTHING',
        v_role, v_code
      );
    END LOOP;
  END LOOP;

  -- Trưởng kho: chỉ xem toàn bộ các phân hệ; ngoại lệ duy nhất là CRUD tài
  -- khoản vai trò thấp hơn (API vẫn kiểm cấp bậc + chủ sở hữu cuối cùng).
  DELETE FROM public.role_permission_matrix WHERE role::text = 'warehouse_manager';
  FOREACH v_code IN ARRAY v_manager LOOP
    INSERT INTO public.role_permission_matrix (role, permission_code)
    VALUES ('warehouse_manager', v_code)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- Nhân viên đóng gói: chỉ xem vận hành/video; camera live bị giới hạn tại
  -- bàn được phân công bởi live station access guard.
  DELETE FROM public.role_permission_matrix WHERE role::text = 'packer';
  FOREACH v_code IN ARRAY v_packer LOOP
    INSERT INTO public.role_permission_matrix (role, permission_code)
    VALUES ('packer', v_code)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- Quan sát viên: chỉ xem tổng quan, vận hành và bằng chứng.
  DELETE FROM public.role_permission_matrix WHERE role::text = 'viewer';
  FOREACH v_code IN ARRAY v_viewer LOOP
    INSERT INTO public.role_permission_matrix (role, permission_code)
    VALUES ('viewer', v_code)
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_role_permission_matrix(
  p_matrix jsonb,
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
  v_roles constant text[] := ARRAY[
    'owner', 'admin', 'warehouse_manager', 'shift_leader', 'packer', 'viewer'
  ];
  v_role text;
  v_code text;
  v_all_codes text[];
BEGIN
  IF jsonb_typeof(p_matrix) <> 'object' THEN
    RAISE EXCEPTION 'p_matrix must be an object';
  END IF;

  FOREACH v_role IN ARRAY v_roles LOOP
    IF NOT (p_matrix ? v_role) OR jsonb_typeof(p_matrix -> v_role) <> 'array' THEN
      RAISE EXCEPTION 'missing/invalid role %', v_role;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_matrix) AS k(role)
    WHERE NOT (k.role = ANY (v_roles))
  ) THEN
    RAISE EXCEPTION 'matrix contains unknown role';
  END IF;

  SELECT array_agg(DISTINCT value ORDER BY value)
    INTO v_all_codes
  FROM jsonb_each(p_matrix) AS roles(role, grants)
  CROSS JOIN LATERAL jsonb_array_elements_text(roles.grants) AS codes(value);

  -- Lưới DB độc lập với UI: owner/admin không được thiếu bất kỳ mã nào có
  -- trong ma trận gửi lên.
  FOREACH v_code IN ARRAY coalesce(v_all_codes, ARRAY[]::text[]) LOOP
    IF NOT ((p_matrix -> 'owner') ? v_code) OR NOT ((p_matrix -> 'admin') ? v_code) THEN
      RAISE EXCEPTION 'owner/admin must retain full access: %', v_code;
    END IF;
  END LOOP;

  DELETE FROM public.role_permission_matrix
  WHERE role::text = ANY (v_roles);

  FOREACH v_role IN ARRAY v_roles LOOP
    FOR v_code IN SELECT jsonb_array_elements_text(p_matrix -> v_role)
    LOOP
      INSERT INTO public.role_permission_matrix (role, permission_code)
      VALUES (v_role::public.user_role, v_code)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  INSERT INTO public.platform_audit_log (
    actor_user_id,
    actor_email,
    action,
    target_type,
    target_id,
    metadata,
    actor_email_snapshot,
    actor_role_snapshot
  ) VALUES (
    p_actor_user_id,
    p_actor_email,
    'platform.rbac.update',
    'role_permission_matrix',
    'global',
    coalesce(p_metadata, '{}'::jsonb),
    p_actor_email,
    p_actor_role
  );
END;
$$;

REVOKE ALL ON FUNCTION public.replace_role_permission_matrix(jsonb, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_role_permission_matrix(jsonb, uuid, text, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_role_permission_matrix(jsonb, uuid, text, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.replace_role_permission_matrix(jsonb, uuid, text, text, jsonb) IS
  'Atomically replaces tenant RBAC grants and records platform audit. Service role only; route requires platform_owner.';

COMMIT;
