-- ============================================================================
-- Verify migration 20260807100000_packing_timing_single_source_180.
--
-- TOÀN BỘ READ-ONLY. Chạy sau khi apply, đọc từng section và đối chiếu
-- với dòng "Kỳ vọng".
--
-- Verify HAI NỬA:
--   nửa dương-đúng: nguồn mới trả đúng số, function đọc qua nguồn đó.
--   nửa âm-đúng: 2 kho đang chạy KHÔNG bị đổi hành vi, không còn literal
--                600 sót lại trong bất kỳ function nào.
-- ============================================================================

-- ============================================================================
-- SECTION 1: nguồn mặc định tồn tại và trả 180
-- ============================================================================
SELECT public.packing_timing_default_config() AS defaults;
-- Kỳ vọng: max_order_seconds = 180, stale_session_hours = 12,
--          stale_warning_hours = 4, checkout_gap_cap_multiplier = 3,
--          default_last_order_seconds = 60.

-- ============================================================================
-- SECTION 2: column default trỏ vào function, không phải literal
-- ============================================================================
SELECT column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'warehouses'
  AND column_name = 'packing_timing_config';
-- Kỳ vọng: 'packing_timing_default_config()' — KHÔNG còn jsonb_build_object(...).

-- ============================================================================
-- SECTION 3 (nửa âm-đúng): 2 kho đang chạy giữ nguyên giá trị đã lưu
-- ============================================================================
SELECT
  w.name,
  (w.packing_timing_config ->> 'max_order_seconds') AS stored_max_order,
  (public.resolve_packing_timing(w.id) ->> 'max_order_seconds') AS resolved_max_order,
  (public.resolve_packing_timing(w.id) ->> 'stale_session_hours') AS resolved_stale_hours
FROM public.warehouses w
ORDER BY w.created_at;
-- Kỳ vọng: stored = resolved cho cả 2 kho (Đại Kim 180, Betacom Demo 600) —
--          migration KHÔNG được đổi giá trị kho đã cấu hình.
--          resolved_stale_hours = 12 cho cả hai, kể cả kho Đại Kim vốn
--          KHÔNG lưu key này (trước đây phải dựa vào literal trong function).

-- ============================================================================
-- SECTION 4: không còn hằng số rải rác trong function
-- ============================================================================
SELECT p.proname,
       (p.prosrc LIKE '%600%') AS con_literal_600,
       (p.prosrc LIKE '%coalesce((v_cfg%') AS con_coalesce_cfg,
       (p.prosrc LIKE '%resolve_packing_timing%') AS doc_qua_nguon_chung
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'process_waybill_scan',
    '_finalize_open_packing_for_station_at',
    'close_stale_sessions',
    'list_stale_session_warnings'
  )
ORDER BY p.proname;
-- Kỳ vọng: cả 4 function có doc_qua_nguon_chung = true,
--          con_literal_600 = false, con_coalesce_cfg = false.

-- ============================================================================
-- SECTION 5: kho tạo mới nhận đúng mặc định 180 (không chèn row thật)
-- ============================================================================
SELECT (public.packing_timing_default_config() ->> 'max_order_seconds')::int AS new_warehouse_max_order;
-- Kỳ vọng: 180. Trước migration, kho mới nhận 180 từ column default trong
--          khi process_waybill_scan lại fallback 600 — chính là drift đã
--          làm kho Đại Kim (tạo 2026-07-24) chạy 180 dù chốt là 600.
