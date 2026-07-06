-- A3 — Fix SELECT policy bypass quá tay ở 22 bảng.
--
-- Ca 5 (test-platform-impersonate.ts nửa-âm) phát hiện: platform admin
-- impersonate org A → /api/warehouses thấy ALL warehouses (org A + B + khác)
-- thay vì chỉ org A. Nguyên nhân: SELECT policy `is_platform_admin() OR ...`
-- cho platform admin bypass hoàn toàn, KHÔNG giới hạn theo org-token
-- (vì SQL không đọc x-internal-org-ctx header).
--
-- Fix: BỎ nhánh `is_platform_admin() OR` khỏi SELECT policy 22 bảng.
-- Platform admin không dùng session client (RLS) nữa; thay vào đó dùng
-- admin client bypass RLS + filter app-layer theo ctx.organizationId (từ
-- token proxy-ký sau gate). Đây là đường đúng — SQL không giới hạn được
-- token, app-layer phải làm.
--
-- Ảnh hưởng:
-- - Tenant: KHÔNG đổi (nhánh còn lại `organization_id = current_org_id()`
--   vẫn giữ; tenant JWT có org_id → current_org_id() trả đúng → policy hoạt
--   động như cũ).
-- - Platform admin qua session client: giờ 0-row (JWT không có org_id →
--   current_org_id() = null → không match). BUỘC platform dùng admin client
--   + app-filter (đường đúng).
-- - Route Handler (Node): thay vì rải if-else 7 chỗ, gói vào helper
--   getScopedClient(ctx) — helper luôn-filter cho nhánh platform, một
--   điểm review được.
--
-- 22 statement CỤ THỂ, không loop-mù:
-- - 19 bảng thường: qual mới = `organization_id = current_org_id()`.
-- - organizations: qual mới = `id = current_org_id()` (không phải
--   organization_id, vì bảng này lookup bằng id).
-- - 2 bảng role-check (audit_logs + staff_qr_credentials): GIỮ role_check,
--   chỉ bỏ `is_platform_admin() OR`. Không loop-mù bỏ nhầm role_check.

-- ============================================================================
-- 19 bảng thường (organization_id = current_org_id)
-- ============================================================================

DROP POLICY IF EXISTS "agent_commands platform or org select" ON public.agent_commands;
CREATE POLICY "agent_commands org select" ON public.agent_commands
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "camera_recording_files platform or org select" ON public.camera_recording_files;
CREATE POLICY "camera_recording_files org select" ON public.camera_recording_files
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "camera_recording_sessions platform or org select" ON public.camera_recording_sessions;
CREATE POLICY "camera_recording_sessions org select" ON public.camera_recording_sessions
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "cameras platform or org select" ON public.cameras;
CREATE POLICY "cameras org select" ON public.cameras
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "order_proof_clips platform or org select" ON public.order_proof_clips;
CREATE POLICY "order_proof_clips org select" ON public.order_proof_clips
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "orders platform or org select" ON public.orders;
CREATE POLICY "orders org select" ON public.orders
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "packing_events platform or org select" ON public.packing_events;
CREATE POLICY "packing_events org select" ON public.packing_events
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "packing_stations platform or org select" ON public.packing_stations;
CREATE POLICY "packing_stations org select" ON public.packing_stations
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "staff_profiles platform or org select" ON public.staff_profiles;
CREATE POLICY "staff_profiles org select" ON public.staff_profiles
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "staff_qr_scan_results platform or org select" ON public.staff_qr_scan_results;
CREATE POLICY "staff_qr_scan_results org select" ON public.staff_qr_scan_results
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "staff_warehouse_assignments platform or org select" ON public.staff_warehouse_assignments;
CREATE POLICY "staff_warehouse_assignments org select" ON public.staff_warehouse_assignments
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "staff_work_session_events platform or org select" ON public.staff_work_session_events;
CREATE POLICY "staff_work_session_events org select" ON public.staff_work_session_events
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "staff_work_sessions platform or org select" ON public.staff_work_sessions;
CREATE POLICY "staff_work_sessions org select" ON public.staff_work_sessions
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "station_device_assignments platform or org select" ON public.station_device_assignments;
CREATE POLICY "station_device_assignments org select" ON public.station_device_assignments
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "station_devices platform or org select" ON public.station_devices;
CREATE POLICY "station_devices org select" ON public.station_devices
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "user_profiles platform or org select" ON public.user_profiles;
CREATE POLICY "user_profiles org select" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "warehouse_agents platform or org select" ON public.warehouse_agents;
CREATE POLICY "warehouse_agents org select" ON public.warehouse_agents
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "warehouse_scan_raw_events platform or org select" ON public.warehouse_scan_raw_events;
CREATE POLICY "warehouse_scan_raw_events org select" ON public.warehouse_scan_raw_events
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

DROP POLICY IF EXISTS "warehouses platform or org select" ON public.warehouses;
CREATE POLICY "warehouses org select" ON public.warehouses
  FOR SELECT TO authenticated
  USING (organization_id = app.current_org_id());

-- ============================================================================
-- organizations: id = current_org_id (không phải organization_id)
-- ============================================================================

DROP POLICY IF EXISTS "organizations platform or org select" ON public.organizations;
CREATE POLICY "organizations org select" ON public.organizations
  FOR SELECT TO authenticated
  USING (id = app.current_org_id());

-- ============================================================================
-- 2 bảng role-check: GIỮ role_check, chỉ bỏ `is_platform_admin() OR`
-- ============================================================================

-- audit_logs: role IN (owner, admin)
DROP POLICY IF EXISTS "audit_logs platform or org admin select" ON public.audit_logs;
CREATE POLICY "audit_logs org admin select" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    organization_id = app.current_org_id()
    AND app.current_role() = ANY (ARRAY['owner'::user_role, 'admin'::user_role])
  );

-- staff_qr_credentials: role IN (owner, admin, warehouse_manager)
DROP POLICY IF EXISTS "staff_qr_credentials platform or org admin select" ON public.staff_qr_credentials;
CREATE POLICY "staff_qr_credentials org admin select" ON public.staff_qr_credentials
  FOR SELECT TO authenticated
  USING (
    organization_id = app.current_org_id()
    AND app.current_role() = ANY (ARRAY['owner'::user_role, 'admin'::user_role, 'warehouse_manager'::user_role])
  );
