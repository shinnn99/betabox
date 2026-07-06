-- ============================================================================
-- KNOWN DUPLICATE VERSION — DO NOT RENAME.
--
-- File này CÙNG version `20260704160000` với `_n1_indexes_for_dashboard_live_queries.sql`.
-- MCP query prod 2026-07-07 xác nhận cả 2 đã chạy nhưng `schema_migrations`
-- chỉ ghi 1 row với name của file `_n1_indexes...`. Rename tạo drift.
--
-- Reconciliation: `20260707140000_reconcile_duplicate_20260704160000.sql`
-- (idempotent, đảm bảo state đúng trên fresh clone).
--
-- KHÔNG TẠO file cùng version 20260704160000 khác. CI guard
-- `scripts/check-migration-versions.mjs` chặn file thứ 3.
-- Chi tiết: docs/remediation-2026-07-b0.md
-- ============================================================================

-- Drop 5 cột metadata không dùng trong nghiệp vụ vận hành kho:
--   legal_name, tax_code, phone, email, address
-- Lý do: hệ chỉ vận hành camera + QR staff + order proof. Không nghiệp vụ nào
-- tiêu thụ mấy field này (không xuất hoá đơn, không gửi email hệ thống theo
-- email tổ chức). Giữ chúng chỉ làm rối UI signup/edit-org.
-- Card "Thông tin tổ chức" hiển thị: tên, slug, chủ sở hữu, trạng thái, gói
-- → tất cả đến từ cột khác (name, slug, user_profiles.owner, status, plan).

ALTER TABLE public.organizations DROP COLUMN IF EXISTS legal_name;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS tax_code;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS phone;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS email;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS address;

-- Guard: xác nhận 5 cột đã bị drop
DO $$
DECLARE
  leftover_count int;
BEGIN
  SELECT COUNT(*) INTO leftover_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'organizations'
    AND column_name IN ('legal_name', 'tax_code', 'phone', 'email', 'address');

  IF leftover_count > 0 THEN
    RAISE EXCEPTION 'drop_organizations_metadata: still % columns left', leftover_count;
  END IF;
END $$;
