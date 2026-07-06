-- ============================================================================
-- B1.2: preserve audit history when identities are deleted +
--       immutable actor/organization snapshots.
--
-- Discovery MCP prod 2026-07-07 (docs/remediation-2026-07-b1-2.md):
--
--   platform_audit_log (0 rows):
--     actor_user_id            uuid NOT NULL, FK auth.users NO ACTION
--       → xóa auth user bị block; nếu bằng cách nào đó xóa được, audit
--         không lưu snapshot ai đã thao tác.
--     impersonating_org_id     uuid NULL,     FK organizations NO ACTION
--       → xóa org bị block; audit không lưu snapshot org name.
--
--   platform_admins (1 row, created_by IS NULL):
--     id (PK)                  uuid, FK auth.users CASCADE
--       → design: id = auth.users.id; xóa user = xóa role. GIỮ.
--     created_by               uuid NULL, FK auth.users NO ACTION
--       → xóa creator (VD platform_owner cũ rời) bị block.
--
--   audit_logs (202 rows):
--     actor_user_id            uuid NULL, FK auth.users SET NULL  ✓ đúng chuẩn
--     organization_id          uuid NOT NULL, FK organizations CASCADE
--       → xóa org = xóa hết 202 audit của org đó. Vi phạm retention 365 ngày.
--
-- Fix (retention policy: audit rows tồn tại độc lập với actor/target
-- lifecycle):
--   1. FK ON DELETE SET NULL cho:
--        - platform_audit_log.actor_user_id  (drop NOT NULL trước)
--        - platform_audit_log.impersonating_org_id
--        - platform_admins.created_by
--        - audit_logs.organization_id  (drop NOT NULL trước)
--   2. Immutable snapshot columns:
--        - platform_audit_log.actor_email_snapshot text NULL
--        - platform_audit_log.actor_role_snapshot text NULL
--        - platform_audit_log.target_organization_name_snapshot text NULL
--        - audit_logs.actor_email_snapshot text NULL   (audit_logs đã có
--          actor_email — dùng làm snapshot lịch sử; thêm snapshot fields
--          cho consistency với platform_audit_log)
--        - audit_logs.organization_id_snapshot uuid NULL
--        - audit_logs.organization_name_snapshot text NULL
--   3. Backfill: chỉ backfill snapshot từ dữ liệu có căn cứ. platform_audit_log
--      trống → không cần backfill. audit_logs 202 rows: backfill
--      organization_id_snapshot = organization_id (self), backfill
--      organization_name_snapshot từ organizations.name (JOIN hiện tại — chỉ
--      những row org còn tồn tại). actor_email đã có sẵn → snapshot copy.
--   4. Retention policy 365 ngày: chỉ ghi vào COMMENT ON TABLE. KHÔNG tạo
--      cron cleanup trong migration này.
--
-- Deploy ordering: migration này phải deploy TRƯỚC khi helper code
-- (audit-core.ts) ghi vào snapshot columns. Nếu helper deploy trước
-- migration → INSERT trả error "column does not exist". Nếu migration
-- deploy trước helper → column tồn tại nhưng helper cũ không ghi snapshot
-- → snapshot NULL cho audit rows mới trong window đó — acceptable
-- (retention degraded window, không mất row).
--
-- Idempotent: ALTER COLUMN IF EXISTS + IF NOT EXISTS + DROP CONSTRAINT
-- IF EXISTS + CREATE CONSTRAINT tên deterministic. DO $$ postcondition
-- guards để RAISE nếu state sau apply không match kỳ vọng.
--
-- KHÔNG chạy migration này lên shared DB trong phiên này.
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: platform_audit_log
-- ============================================================================

-- 1a. Drop NOT NULL cho actor_user_id (bảng đang trống, không cần backfill).
ALTER TABLE public.platform_audit_log
  ALTER COLUMN actor_user_id DROP NOT NULL;

-- 1b. Drop FK cũ + tạo mới ON DELETE SET NULL cho actor_user_id.
ALTER TABLE public.platform_audit_log
  DROP CONSTRAINT IF EXISTS platform_audit_log_actor_user_id_fkey;
ALTER TABLE public.platform_audit_log
  ADD CONSTRAINT platform_audit_log_actor_user_id_fkey
  FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 1c. Drop FK cũ + tạo mới ON DELETE SET NULL cho impersonating_org_id.
ALTER TABLE public.platform_audit_log
  DROP CONSTRAINT IF EXISTS platform_audit_log_impersonating_org_id_fkey;
ALTER TABLE public.platform_audit_log
  ADD CONSTRAINT platform_audit_log_impersonating_org_id_fkey
  FOREIGN KEY (impersonating_org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

-- 1d. Thêm snapshot columns.
ALTER TABLE public.platform_audit_log
  ADD COLUMN IF NOT EXISTS actor_email_snapshot text,
  ADD COLUMN IF NOT EXISTS actor_role_snapshot text,
  ADD COLUMN IF NOT EXISTS target_organization_name_snapshot text;

COMMENT ON COLUMN public.platform_audit_log.actor_email_snapshot IS
  'B1.2 immutable snapshot: actor email tại thời điểm audit event. Không update khi user đổi email.';
COMMENT ON COLUMN public.platform_audit_log.actor_role_snapshot IS
  'B1.2 immutable snapshot: platform role (platform_owner/platform_support) tại thời điểm audit event.';
COMMENT ON COLUMN public.platform_audit_log.target_organization_name_snapshot IS
  'B1.2 immutable snapshot: organization name khi impersonate. Giữ khi org bị xóa (FK SET NULL).';

-- ============================================================================
-- SECTION 2: platform_admins
-- ============================================================================

-- 2a. Drop FK cũ + tạo mới ON DELETE SET NULL cho created_by.
--     KHÔNG đụng FK id → auth.users (CASCADE là design đúng: xóa user = xóa role).
ALTER TABLE public.platform_admins
  DROP CONSTRAINT IF EXISTS platform_admins_created_by_fkey;
ALTER TABLE public.platform_admins
  ADD CONSTRAINT platform_admins_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ============================================================================
-- SECTION 3: audit_logs — preserve when org deleted
-- ============================================================================

-- 3a. Thêm snapshot columns TRƯỚC khi drop NOT NULL/FK.
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS organization_id_snapshot uuid,
  ADD COLUMN IF NOT EXISTS organization_name_snapshot text;

COMMENT ON COLUMN public.audit_logs.organization_id_snapshot IS
  'B1.2 immutable snapshot: organization_id tại thời điểm audit. Giữ khi org bị xóa (FK SET NULL trên organization_id).';
COMMENT ON COLUMN public.audit_logs.organization_name_snapshot IS
  'B1.2 immutable snapshot: organization name tại thời điểm audit. Giữ khi org bị xóa.';

-- 3b. Backfill snapshot từ dữ liệu hiện tại (có căn cứ).
--     organization_id_snapshot = organization_id (self-copy).
--     organization_name_snapshot = JOIN organizations.name (chỉ những row
--     org còn tồn tại; org đã xóa → NULL rõ ràng).
UPDATE public.audit_logs al
SET organization_id_snapshot = al.organization_id
WHERE organization_id_snapshot IS NULL
  AND al.organization_id IS NOT NULL;

UPDATE public.audit_logs al
SET organization_name_snapshot = o.name
FROM public.organizations o
WHERE al.organization_id = o.id
  AND al.organization_name_snapshot IS NULL;

-- 3c. Drop NOT NULL trên organization_id để cho phép SET NULL khi org xóa.
ALTER TABLE public.audit_logs
  ALTER COLUMN organization_id DROP NOT NULL;

-- 3d. Drop FK cũ (CASCADE) + tạo mới SET NULL.
ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_organization_id_fkey;
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

-- ============================================================================
-- SECTION 4: Retention policy metadata (docs only, no cleanup cron)
-- ============================================================================
COMMENT ON TABLE public.platform_audit_log IS
  'Platform admin audit trail. Retention policy: 365 ngày (product decision 2026-07-07). '
  'Chưa có cleanup cron trong B1.2 — sẽ thiết kế + test riêng trước khi bật. '
  'Immutable actor snapshot: actor_email_snapshot / actor_role_snapshot / target_organization_name_snapshot. '
  'FK SET NULL bảo toàn audit khi actor hoặc target bị xóa.';

COMMENT ON TABLE public.audit_logs IS
  'Per-tenant admin audit trail. Retention policy: 365 ngày (product decision 2026-07-07). '
  'Chưa có cleanup cron. Immutable snapshot: organization_id_snapshot + organization_name_snapshot. '
  'FK SET NULL trên organization_id + actor_user_id bảo toàn audit khi tenant hoặc actor bị xóa.';

-- ============================================================================
-- SECTION 5: Postcondition guards
-- ============================================================================
DO $$
DECLARE
  wrong_delete_action int;
BEGIN
  -- 5a. Verify FK SET NULL đã áp cho 4 constraint mới.
  SELECT count(*) INTO wrong_delete_action
  FROM pg_constraint con
  JOIN pg_class cl ON con.conrelid = cl.oid
  JOIN pg_namespace ns ON cl.relnamespace = ns.oid
  WHERE ns.nspname = 'public'
    AND con.contype = 'f'
    AND con.conname IN (
      'platform_audit_log_actor_user_id_fkey',
      'platform_audit_log_impersonating_org_id_fkey',
      'platform_admins_created_by_fkey',
      'audit_logs_organization_id_fkey'
    )
    AND con.confdeltype <> 'n';  -- 'n' = SET NULL

  IF wrong_delete_action > 0 THEN
    RAISE EXCEPTION
      'b1_2 postcondition failed: % constraint(s) not SET NULL after migration',
      wrong_delete_action;
  END IF;

  -- 5b. Verify snapshot columns đã tạo.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_audit_log'
      AND column_name = 'actor_email_snapshot'
  ) THEN
    RAISE EXCEPTION 'b1_2 postcondition failed: platform_audit_log.actor_email_snapshot not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_logs'
      AND column_name = 'organization_id_snapshot'
  ) THEN
    RAISE EXCEPTION 'b1_2 postcondition failed: audit_logs.organization_id_snapshot not created';
  END IF;

  -- 5c. Verify actor_user_id + organization_id đã drop NOT NULL.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_audit_log'
      AND column_name = 'actor_user_id'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'b1_2 postcondition failed: platform_audit_log.actor_user_id still NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_logs'
      AND column_name = 'organization_id'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'b1_2 postcondition failed: audit_logs.organization_id still NOT NULL';
  END IF;
END $$;

COMMIT;
