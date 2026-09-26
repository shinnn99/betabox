-- ============================================================================
-- Bản tự khai của agent — `warehouse_agents.self_report`
-- (kế hoạch VAN-HANH-NHIEU-KHO, đợt 7, phần 4.1)
--
-- VÌ SAO CẦN: 25/09/2026, để biết máy kho đã cài agent 0.12.0 chưa, phải nhờ
-- chủ dự án gõ lệnh trên máy kho và đọc KÍCH THƯỚC FILE EXE. Heartbeat chỉ
-- gửi ping + độ lệch giờ. Một kho thì phiền, năm mươi kho thì không làm nổi.
--
-- AGENT KHAI BÁO, CLOUD PHÁN XÉT. Mỗi nhịp tim agent gửi kèm một bảng trạng
-- thái ngắn (phiên bản, camera nào đang ghi, ổ còn bao nhiêu, hàng đợi, lần
-- đọc QR cuối, khả năng hỗ trợ). Cloud quyết định cái gì là lỗi — đổi ngưỡng
-- là sửa một chỗ trên cloud, không phải dựng bản agent mới rồi đi cài từng
-- máy. Khối lượng không đổi theo số việc xảy ra (khác `agent_log_events`:
-- 26.990 dòng một tuần cho một kho).
--
-- Ghi ĐÈ mỗi nhịp — chỉ giữ bản mới nhất. Lịch sử sự cố nằm ở sổ
-- `warehouse_incidents`, không ở đây.
--
-- `agent_version` tách thành cột riêng để lọc / sắp được ("kho nào còn chạy
-- bản cũ") mà không phải bóc JSON.
--
-- NULL = agent bản cũ chưa biết tự khai (≤ 0.12.x) — cloud hiện "chưa khai",
-- không suy ra là hỏng.
--
-- Kèm theo (cuối file): cho phép loại lệnh `collect_diagnostics`.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả. Không đụng dữ liệu cũ.
-- ============================================================================

BEGIN;

ALTER TABLE public.warehouse_agents
  ADD COLUMN IF NOT EXISTS self_report    jsonb       NULL,
  ADD COLUMN IF NOT EXISTS self_report_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS agent_version  text        NULL;

COMMENT ON COLUMN public.warehouse_agents.self_report IS
  'Bản tự khai mới nhất của agent (ghi đè mỗi nhịp tim): phiên bản, camera đang ghi, ổ đĩa, hàng đợi, lần đọc QR cuối, khả năng hỗ trợ. Xem src/lib/warehouse/self-report.ts.';
COMMENT ON COLUMN public.warehouse_agents.self_report_at IS
  'Lúc nhận bản tự khai mới nhất. Khác last_seen_at: agent bản cũ vẫn ping nhưng không khai.';
COMMENT ON COLUMN public.warehouse_agents.agent_version IS
  'Phiên bản agent tự khai. NULL = bản cũ chưa biết tự khai (≤ 0.12.x).';

-- ---------------------------------------------------------------------------
-- Lệnh `collect_diagnostics` — thu chẩn đoán từ xa (agent ≥ 0.13.0).
-- Cùng khuôn với migration 20260921150000: đọc danh sách loại lệnh HIỆN CÓ
-- (hai dạng Postgres in ra), thêm loại mới, dựng lại ràng buộc. Không đoán
-- danh sách; đọc thiếu thì huỷ cả file.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_def text;
  v_types text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_def
  FROM pg_constraint c
  WHERE c.conname = 'agent_commands_type_check'
    AND c.conrelid = 'public.agent_commands'::regclass;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'khong tim thay rang buoc agent_commands_type_check — dung lai, khong doan danh sach';
  END IF;

  SELECT array_agg(DISTINCT t ORDER BY t)
    INTO v_types
  FROM (
    SELECT m[1] AS t FROM regexp_matches(v_def, '''([a-z_]+)''', 'g') AS m
    UNION
    SELECT btrim(x)
    FROM regexp_matches(v_def, '''\{([a-z_,]+)\}''', 'g') AS a,
         unnest(string_to_array(a[1], ',')) AS x
  ) s
  WHERE t <> '';

  IF v_types IS NULL OR array_length(v_types, 1) < 5 THEN
    RAISE EXCEPTION 'doc duoc qua it loai lenh tu rang buoc hien tai (%): dung lai', v_def;
  END IF;

  IF NOT ('collect_diagnostics' = ANY (v_types)) THEN
    v_types := array_append(v_types, 'collect_diagnostics'::text);
  END IF;

  ALTER TABLE public.agent_commands DROP CONSTRAINT agent_commands_type_check;
  EXECUTE format(
    'ALTER TABLE public.agent_commands ADD CONSTRAINT agent_commands_type_check CHECK (type = ANY (%L::text[]))',
    v_types
  );

  RAISE NOTICE 'agent_commands_type_check: % loai lenh', array_length(v_types, 1);
END;
$$;

COMMIT;
