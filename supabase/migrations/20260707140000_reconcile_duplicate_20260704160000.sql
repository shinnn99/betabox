-- ============================================================================
-- Reconciliation cho duplicate version `20260704160000`.
--
-- Bối cảnh (B0 report 2026-07-07):
--   Version 20260704160000 có 2 file trên đĩa:
--     - _drop_organizations_metadata_columns.sql
--     - _n1_indexes_for_dashboard_live_queries.sql
--   MCP query prod (2026-07-07):
--     - supabase_migrations.schema_migrations có 1 row với version này,
--       name = 'n1_indexes_for_dashboard_live_queries' (file B).
--     - Cả 2 tác dụng đã có mặt trên prod: 5 cột đã drop khỏi
--       organizations; 3 index đã tồn tại đúng shape.
--   Kết luận: `supabase db push` chạy alphabet ('d' < 'n') → file A chạy
--   trước file B, nhưng CLI ghi 1 row duy nhất với tên file cuối. Đây
--   là drift âm — không thể phát hiện qua CLI.
--
-- Vì sao KHÔNG rename file lịch sử:
--   Rename tạo drift positive khác — CLI thấy version+name không match
--   `schema_migrations` sẽ coi là migration mới, cố chạy lại. File A
--   idempotent (IF EXISTS + DO guard), file B idempotent (IF NOT EXISTS).
--   Nhưng Supabase CLI ≥ v2.90 có kiểm tra name trong dev/staging clone,
--   sẽ báo drift. An toàn hơn là để nguyên lịch sử + tạo migration này.
--
-- Vai trò của file này:
--   1. Idempotent re-apply cả 2 tác dụng — với fresh dev/staging/clone
--      không có drift lịch sử, file này đảm bảo state cuối đúng ngay cả
--      khi 1 trong 2 file gốc bị skip vì cùng version với file khác.
--   2. Đóng vai trò "checkpoint đã reconcile" — sau file này, không cần
--      xử lý version duplicate 20260704160000 nữa.
--   3. KHÔNG thao tác `supabase_migrations.schema_migrations`.
--
-- Guarantees:
--   - Không thay đổi trạng thái prod (5 cột đã drop, 3 index đã tồn tại).
--   - Trên fresh clone: đảm bảo cả 5 cột drop + 3 index tồn tại sau khi
--     file này chạy.
--   - Idempotent tuyệt đối: chạy lặp lại không tạo lỗi.
--   - Không xóa data.
--   - Không drop/recreate object đúng sẵn.
--
-- CI guard: `scripts/check-migration-versions.mjs` whitelist EXACT cặp
-- duplicate này. File thứ ba cùng version = fail. Duplicate version
-- khác = fail.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- File A effect: drop 5 metadata columns từ public.organizations
-- ----------------------------------------------------------------------------
-- IF EXISTS: idempotent. Trên prod đã drop → no-op. Trên fresh clone
-- chưa drop → drop.
ALTER TABLE public.organizations DROP COLUMN IF EXISTS legal_name;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS tax_code;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS phone;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS email;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS address;

-- Guard: xác nhận 5 cột đã bị drop (postcondition).
DO $$
DECLARE
  leftover int;
BEGIN
  SELECT count(*) INTO leftover
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'organizations'
    AND column_name IN ('legal_name', 'tax_code', 'phone', 'email', 'address');
  IF leftover > 0 THEN
    RAISE EXCEPTION
      'reconcile 20260704160000: file A postcondition failed — % legacy metadata column(s) still present',
      leftover;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- File B effect: 3 index cho dashboard/live hot queries
-- ----------------------------------------------------------------------------
-- IF NOT EXISTS: idempotent. Trên prod đã tồn tại → no-op. Trên fresh
-- clone chưa có → tạo.
--
-- Không CONCURRENTLY: trong transaction. Với data Mốc 1 (~45 rows
-- packing_events) lock write 1-2s ngoài giờ chấp nhận được, giữ nguyên
-- lý do trong file gốc.
CREATE INDEX IF NOT EXISTS idx_packing_events_org_business_date
  ON public.packing_events (organization_id, business_date);

CREATE INDEX IF NOT EXISTS idx_packing_events_org_scanned_at
  ON public.packing_events (organization_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_warehouse_scan_raw_events_org_received_at
  ON public.warehouse_scan_raw_events (organization_id, received_at DESC);

-- Guard: xác nhận 3 index tồn tại đúng shape (postcondition).
DO $$
DECLARE
  missing int;
BEGIN
  SELECT count(*) INTO missing
  FROM (VALUES
    ('idx_packing_events_org_business_date'),
    ('idx_packing_events_org_scanned_at'),
    ('idx_warehouse_scan_raw_events_org_received_at')
  ) AS need(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = need.name
  );
  IF missing > 0 THEN
    RAISE EXCEPTION
      'reconcile 20260704160000: file B postcondition failed — % expected index(es) missing',
      missing;
  END IF;
END $$;

COMMIT;
