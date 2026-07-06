-- V1: Platform schema (SaaS multi-tenant admin layer)
--
-- Tạo tầng platform admin TRÊN tầng tenant hiện có. Platform admin thấy+quản
-- mọi org (vượt organization_id lock), tenant giữ nguyên khóa org.
--
-- Chỗ nhạy nhất: platform_admins bảng quyết định ai vạn năng.
-- Chiến lược bảo vệ: RLS default-deny authenticated + admin client bypass.
-- KHÔNG policy nào gọi is_platform_admin() → tránh đệ quy vòng lặp RLS.

-- ============================================================================
-- 1. ENUM platform_role
-- ============================================================================
CREATE TYPE public.platform_role AS ENUM ('platform_owner', 'platform_support');

-- ============================================================================
-- 2. BẢNG platform_admins — CHỖ NHẠY NHẤT
-- Bảo vệ chính = guard route (requirePlatformRole), không RLS.
-- RLS default-deny là lớp phụ chặn đường SQL trực tiếp (không phải đường thật).
-- ============================================================================
CREATE TABLE public.platform_admins (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.platform_role NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  notes text
);

CREATE INDEX idx_platform_admins_active
  ON public.platform_admins (id)
  WHERE status = 'active';

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- KHÔNG CREATE POLICY. RLS enabled + không policy = default-deny cho
-- authenticated. Service_role bypass RLS mặc định → admin client thao tác được.
-- Bảo vệ chính = guard route /api/platform/admins/* (requirePlatformRole).

COMMENT ON TABLE public.platform_admins IS
  'Platform admin registry (SaaS operators). RLS: default-deny authenticated, '
  'service_role bypass. Ghi qua admin client only. KHÔNG policy nào tự-gọi '
  'is_platform_admin() (tránh đệ quy vòng lặp RLS).';

-- ============================================================================
-- 3. BẢNG platform_permission_matrix — mirror role_permission_matrix cho platform
-- ============================================================================
CREATE TABLE public.platform_permission_matrix (
  role public.platform_role NOT NULL,
  permission_code text NOT NULL,
  PRIMARY KEY (role, permission_code)
);

ALTER TABLE public.platform_permission_matrix ENABLE ROW LEVEL SECURITY;
-- Default-deny authenticated, service_role bypass. Cùng convention platform_admins.

-- Seed platform_owner full permissions
-- platform_support: chưa liệt (Q6.2 — không đoán quyền, thêm khi có nhân viên thật).
INSERT INTO public.platform_permission_matrix (role, permission_code) VALUES
  ('platform_owner', 'platform.org.list'),
  ('platform_owner', 'platform.org.impersonate'),
  ('platform_owner', 'platform.admin.add'),
  ('platform_owner', 'platform.admin.remove'),
  ('platform_owner', 'platform.audit.view');

-- ============================================================================
-- 4. BẢNG platform_audit_log — audit thao tác platform admin trên data tenant
-- ip_address: cột dành cho x-forwarded-for (cọc skeleton 1 allowlist sau)
-- ============================================================================
CREATE TABLE public.platform_audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  actor_email text,
  impersonating_org_id uuid REFERENCES public.organizations(id),
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_audit_log ENABLE ROW LEVEL SECURITY;
-- Default-deny. Ghi qua admin client. Đọc qua route /api/platform/audit gated
-- bằng requirePlatformRole.

CREATE INDEX idx_platform_audit_actor_time
  ON public.platform_audit_log (actor_user_id, created_at DESC);

CREATE INDEX idx_platform_audit_org_time
  ON public.platform_audit_log (impersonating_org_id, created_at DESC)
  WHERE impersonating_org_id IS NOT NULL;

-- ============================================================================
-- 5. FUNCTION app.is_platform_admin() — helper RLS cho pattern platform-aware
--
-- SECURITY DEFINER: bypass RLS khi đọc platform_admins → tránh đệ quy nếu sau
-- này platform_admins có RLS policy (hiện không có, defensive).
-- STABLE: kết quả không đổi trong 1 query → Postgres cache, hot path.
-- REVOKE PUBLIC + GRANT authenticated,service_role: anonymous không gọi được.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE id = auth.uid()
      AND status = 'active'
  );
$$;

REVOKE EXECUTE ON FUNCTION app.is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_platform_admin() TO authenticated, service_role;

COMMENT ON FUNCTION app.is_platform_admin() IS
  'Returns true if auth.uid() is active platform admin. SECURITY DEFINER '
  'bypasses RLS on platform_admins. Called from RLS policies on tenant tables '
  '(pattern: is_platform_admin() OR organization_id = app.current_org_id()). '
  'Not called from platform_admins RLS itself (default-deny, no policies).';
