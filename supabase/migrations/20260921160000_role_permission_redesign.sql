-- ============================================================================
-- Phân lại quyền theo vai trò (chủ dự án chốt 21/09/2026)
--
--   Chủ sở hữu, Quản trị (admin) : FULL quyền.
--   Trưởng kho (warehouse_manager): full quyền, TRỪ setup camera — gồm camera,
--                                   gán camera/thiết bị vào bàn, thiết bị kho
--                                   khác và máy trạm (agent, reset secret).
--   Quan sát viên (viewer)        : chỉ xem và tải video — trang Giám sát
--                                   đóng/hoàn hàng và Bằng chứng giao/hoàn
--                                   hàng; không sửa gì.
--   Trưởng ca, Nhân viên đóng gói : giữ nguyên, thêm `return.operate` và
--                                   quyền xem + tải video minh chứng.
--
-- MỌI vai trò đều có hai trang video minh chứng (đóng hàng, hoàn hàng):
-- `order_proof.view`, `video.view`, `video.download` (chủ dự án 22/09/2026).
--
-- Quyền mới `return.operate`: mở/đóng phiên nhận hoàn và đổi trạng thái hồ
-- sơ khiếu nại. Trước đây hai thao tác này chỉ đòi quyền xem bằng chứng nên
-- Viewer cũng làm được. Cấp cho mọi vai trò trừ Viewer — không ai đang dùng
-- mất quyền.
--
-- `live.view_remote` giờ thật sự được dùng (xem camera trực tiếp mọi bàn);
-- trước đây code viết cứng owner/admin.
--
-- Bảng quyền dùng chung mọi tổ chức. Tập "mọi quyền" đọc từ chính bảng
-- (không chép cứng) để không sót mã nào đang có trên production.
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_setup text[] := ARRAY[
    'camera.create', 'camera.update', 'camera.archive', 'camera.test',
    'packing_station.camera_setup',
    'station_device.create', 'station_device.update', 'station_device.archive',
    'station_device_assignment.manage'
  ];
  v_viewer text[] := ARRAY[
    'warehouse.view', 'organization.view',
    'order_proof.view', 'video.view', 'video.download',
    'camera.view', 'camera.recording.view', 'live.view_remote'
  ];
  v_all text[];
  v_role text;
  v_code text;
BEGIN
  SELECT array_agg(DISTINCT permission_code ORDER BY permission_code)
    INTO v_all
  FROM public.role_permission_matrix;

  IF v_all IS NULL OR array_length(v_all, 1) < 20 THEN
    RAISE EXCEPTION 'bang quyen hien tai co qua it ma (%): dung lai', array_length(v_all, 1);
  END IF;

  IF NOT ('return.operate' = ANY (v_all)) THEN
    v_all := array_append(v_all, 'return.operate');
  END IF;

  -- Owner, admin, trưởng kho: có mọi mã (trưởng kho bị gỡ nhóm setup ngay sau).
  FOREACH v_role IN ARRAY ARRAY['owner', 'admin', 'warehouse_manager'] LOOP
    FOREACH v_code IN ARRAY v_all LOOP
      EXECUTE format(
        'INSERT INTO public.role_permission_matrix (role, permission_code) VALUES (%L, %L) ON CONFLICT DO NOTHING',
        v_role, v_code
      );
    END LOOP;
  END LOOP;

  DELETE FROM public.role_permission_matrix
  WHERE role::text = 'warehouse_manager'
    AND permission_code = ANY (v_setup);

  -- Viewer: đúng tập xem/tải video, bỏ mọi mã khác.
  DELETE FROM public.role_permission_matrix
  WHERE role::text = 'viewer'
    AND NOT (permission_code = ANY (v_viewer));
  FOREACH v_code IN ARRAY v_viewer LOOP
    EXECUTE format(
      'INSERT INTO public.role_permission_matrix (role, permission_code) VALUES (%L, %L) ON CONFLICT DO NOTHING',
      'viewer', v_code
    );
  END LOOP;

  -- Trưởng ca, nhân viên đóng gói: thêm quyền thao tác hàng hoàn và quyền
  -- xem + tải video minh chứng (mọi vai trò đều có hai trang video).
  FOREACH v_role IN ARRAY ARRAY['shift_leader', 'packer'] LOOP
    FOREACH v_code IN ARRAY ARRAY['return.operate', 'order_proof.view', 'video.view', 'video.download'] LOOP
      EXECUTE format(
        'INSERT INTO public.role_permission_matrix (role, permission_code) VALUES (%L, %L) ON CONFLICT DO NOTHING',
        v_role, v_code
      );
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
