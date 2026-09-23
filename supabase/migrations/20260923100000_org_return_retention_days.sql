-- ============================================================================
-- So ngay giu video HANG HOAN o cap to chuc (chu du an chot 23/09/2026)
--
-- Doan video thuan hang hoan da co han rieng (mac dinh 7 ngay) nhung chi doc
-- duoc tu `warehouses.packing_timing_config.return_segment_retention_days`,
-- khong co cho nao chinh tren giao dien. Them cot o cap to chuc de Cau hinh
-- kho chinh duoc, dat canh o "So ngay giu video" cua don di.
--
-- Thu tu doc (xem src/app/api/agent/retention-plan/route.ts):
--   organizations.return_retention_days
--   -> warehouses.packing_timing_config.return_segment_retention_days
--   -> 7 ngay.
--
-- Cung dai 7-365 ngay voi han chung. NULL = chua cau hinh.
-- ============================================================================

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS return_retention_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_return_retention_days_check'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_return_retention_days_check
      CHECK (return_retention_days IS NULL OR (return_retention_days >= 7 AND return_retention_days <= 365));
  END IF;
END;
$$;

COMMENT ON COLUMN public.organizations.return_retention_days IS
  'So ngay giu doan video thuan hang hoan tren o dia may kho. NULL = chua cau hinh, agent dung 7 ngay.';

COMMIT;
