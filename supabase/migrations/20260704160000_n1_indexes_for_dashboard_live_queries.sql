-- ============================================================================
-- KNOWN DUPLICATE VERSION — DO NOT RENAME.
--
-- File này CÙNG version `20260704160000` với
-- `_drop_organizations_metadata_columns.sql`. MCP query prod 2026-07-07 xác
-- nhận cả 2 đã chạy nhưng `schema_migrations` chỉ ghi 1 row (file này).
--
-- Reconciliation: `20260707140000_reconcile_duplicate_20260704160000.sql`
-- (idempotent, đảm bảo state đúng trên fresh clone).
--
-- KHÔNG TẠO file cùng version 20260704160000 khác. CI guard
-- `scripts/check-migration-versions.mjs` chặn file thứ 3.
-- Chi tiết: docs/remediation-2026-07-b0.md
-- ============================================================================

-- N1: index đúng shape cho query hot của dashboard + live view.
--
-- Bối cảnh (đã verify pg_indexes DB thật 2026-07-04, không grep repo):
--   packing_events đã có (organization_id, created_at DESC) từ dump v0,
--   nhưng các route hot query theo cột KHÁC:
--     - dashboard/overview + reports/performance: WHERE business_date (equality/range)
--     - live/stations + live/summary + live/issues: WHERE scanned_at range
--   Index (org, created_at) không phục vụ query trên business_date/scanned_at
--   → planner phải leading-org rồi filter cột hai in-memory.
--
--   warehouse_scan_raw_events đã có (organization_id, created_at DESC),
--   nhưng live/activity ORDER BY received_at DESC — không phải created_at.
--   → cần index shape đúng ORDER BY.
--
-- Không CONCURRENTLY: Mốc 1 data nhỏ (~45 rows packing_events), lock write
-- 1-2s ngoài giờ chấp nhận được. CONCURRENTLY cần tách file ngoài migration
-- transaction — chỉ đáng khi bảng lớn ở Mốc 3.
--
-- Cọc kích hoạt (KHÔNG làm bây giờ): partial index
--   (organization_id, scanned_at DESC) WHERE status != 'valid'
-- cho live/issues sẽ giúp khi bảng lớn (issues là subset ~13%). Ở data Mốc
-- 1-2, index (org, scanned_at) bên dưới đủ phục vụ issues (filter status
-- in-memory nhanh trên vài nghìn row). Thêm partial khi live/issues chậm
-- đo được ở Mốc 2 (EXPLAIN slow-query). Partial-rộng `!= 'valid'` (không
-- `IN (...)`) để bền với domain evolution.
--
-- Verify shape sau apply: EXPLAIN từng query hot với
-- `SET enable_seqscan = off` — chứng minh index shape khớp query (planner
-- dùng được khi ép). Ở 45 rows, seq-scan là plan bình thường (không phải
-- index sai) — verify sẵn-sàng-cho-data-lớn, không chọn-ngay.

-- 1. dashboard/overview + reports/performance:
--    WHERE organization_id = ? AND business_date = ? (equality)
--    WHERE organization_id = ? AND business_date >= ? AND business_date < ? (range)
CREATE INDEX IF NOT EXISTS idx_packing_events_org_business_date
  ON public.packing_events (organization_id, business_date);

-- 2. live/stations + live/summary + live/issues:
--    WHERE organization_id = ? AND scanned_at >= ? AND scanned_at < ?
--    ORDER BY scanned_at DESC
--    (live/issues thêm `status IN (...)` filter — chấp nhận in-memory ở
--     data Mốc 1-2; thêm partial-status khi đo được chậm ở Mốc 2.)
CREATE INDEX IF NOT EXISTS idx_packing_events_org_scanned_at
  ON public.packing_events (organization_id, scanned_at DESC);

-- 3. live/activity:
--    WHERE organization_id = ? ORDER BY received_at DESC LIMIT ?
CREATE INDEX IF NOT EXISTS idx_warehouse_scan_raw_events_org_received_at
  ON public.warehouse_scan_raw_events (organization_id, received_at DESC);
