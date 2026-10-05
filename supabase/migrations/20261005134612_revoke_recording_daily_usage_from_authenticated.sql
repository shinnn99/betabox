-- ============================================================================
-- Bịt lỗ cross-tenant: hàm SECURITY DEFINER còn cho role `authenticated` gọi
--
-- Vá HAI hàm. Danh sách này KHÔNG suy từ việc đọc file migration — đọc file
-- cho ra 51 hàm thiếu `REVOKE`, nhưng đo trên production 05/10/2026 thì chỉ
-- 2 hàm thật sự còn cho `authenticated` gọi (phần còn lại là trigger function
-- — không gọi qua PostgREST được — hoặc đã bị revoke ở migration sau):
--
--   select p.proname, pg_get_function_identity_arguments(p.oid)
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--        join pg_type t on t.oid=p.prorettype
--   where n.nspname='public' and p.prosecdef and t.typname<>'trigger'
--     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
--   → recording_daily_usage(uuid,integer), station_current_mode(uuid)
--
-- BẰNG CHỨNG ĐÃ CẮN (đo trên production 05/10/2026, không phải suy luận):
--
--   set local role authenticated;
--   select count(*), sum(segments)
--   from public.recording_daily_usage('e3cb7cd1-e869-4d55-936d-5bcb1a1467b8', 14);
--   → days_returned 13, total_segments 11153
--
--   set local role authenticated;
--   select public.station_current_mode('7aa08d2c-5c58-4d51-b293-cfadf8d0f852');
--   → 'outbound'
--
-- Tức là MỘT tài khoản bất kỳ, của BẤT KỲ kho nào, đọc được trọn số liệu ghi
-- hình của kho khác chỉ bằng cách truyền `p_organization_id` khác đi.
--
-- Mức rò hai hàm KHÁC NHAU, ghi đúng chứ không gộp cho to chuyện:
--   * `recording_daily_usage` — rò theo LÔ: một lệnh ra 13 ngày × 11.153
--     segment, chỉ cần biết org_id.
--   * `station_current_mode` — rò NHỎ GIỌT: mỗi lệnh một chuỗi
--     'outbound'/'return', và phải biết trước station_id (uuid, không đoán
--     được). Vẫn là cross-tenant nên vẫn vá, nhưng đừng xếp ngang hàng.
--
-- VÌ SAO XUYÊN ĐƯỢC: hàm là SECURITY DEFINER nên RLS của
-- `camera_recording_files` (RLS đang bật, 1 policy) KHÔNG áp. Hàm lại nằm ở
-- schema `public` nên PostgREST expose ra `/rest/v1/rpc/recording_daily_usage`.
-- `anon` bị chặn, `authenticated` thì không.
--
-- VÌ SAO CÓ LỖ — là SÓT, không phải chủ ý. So ba migration cùng đợt:
--   20261002042335_storage_usage_fn                → CÓ `REVOKE ... FROM authenticated`
--   20261002071526_recording_daily_usage_fn        → THIẾU đúng dòng đó
--   20261002080843_..._split_recording             → THIẾU (chép lại khối GRANT của bản trên)
-- `pg_default_acl` của schema `public` tự cấp EXECUTE cho `authenticated` với
-- mọi hàm mới, nên thiếu dòng REVOKE tường minh = mặc nhiên mở. Mặc định của
-- hệ thống là MỞ; không revoke thì không có gì chặn.
--
-- KHÔNG làm hỏng tính năng nào — đã grep đường gọi của CẢ HAI hàm trước khi
-- viết migration này, cả hai chỉ đi qua admin client (service_role):
--   recording_daily_usage → src/lib/warehouse/storage-health.ts
--   station_current_mode  → src/lib/station/return-scan.ts
--                           (+ gọi nội bộ trong SQL ở 20260921100000, không
--                            phụ thuộc quyền của role gọi vì cùng DEFINER)
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

REVOKE ALL ON FUNCTION public.recording_daily_usage(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recording_daily_usage(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.recording_daily_usage(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recording_daily_usage(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.station_current_mode(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.station_current_mode(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.station_current_mode(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.station_current_mode(uuid) TO service_role;

-- `count_active_owners_app` — KHÁC HAI HÀM TRÊN: trên production nó ĐÃ kín
-- (acl `postgres=X | service_role=X`, `has_function_privilege('authenticated')`
-- = false), nhưng toàn bộ repo KHÔNG có lệnh nào tạo ra trạng thái đó —
-- 20260703215527 chỉ `CREATE OR REPLACE`, không REVOKE.
--
-- Tức là có người revoke tay ngoài migration (cọc "Paste SQL Editor không
-- track migration"). Hệ quả: production kín, còn FRESH CLONE thì hở — ai dựng
-- lại DB từ repo sẽ nhận một hàm SECURITY DEFINER mở cho authenticated.
--
-- Thêm vào đây để repo khớp production. Trên production lệnh này là no-op.
REVOKE ALL ON FUNCTION public.count_active_owners_app(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_active_owners_app(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.count_active_owners_app(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.count_active_owners_app(uuid) TO service_role;

-- Chốt lại ngay trong migration: nếu `authenticated` vẫn gọi được sau khi
-- REVOKE thì dừng ở đây chứ không commit một bản vá chỉ trông-như-đã-vá.
DO $$
DECLARE
  f text;
  fns text[] := ARRAY[
    'public.recording_daily_usage(uuid,integer)',
    'public.station_current_mode(uuid)',
    'public.count_active_owners_app(uuid)'
  ];
BEGIN
  FOREACH f IN ARRAY fns LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'REVOKE không ăn: authenticated vẫn EXECUTE được %', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'REVOKE không ăn: anon vẫn EXECUTE được %', f;
    END IF;

    -- Nửa còn lại: đừng revoke quá tay làm chết đường gọi thật của ứng dụng.
    -- Thiếu vế này thì một bản vá làm trắng trang vẫn "chạy thành công".
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'Revoke quá tay: service_role mất quyền gọi %', f;
    END IF;
  END LOOP;
END
$$;

COMMIT;
