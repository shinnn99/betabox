-- ============================================================================
-- Sổ sự cố — `warehouse_incidents` (kế hoạch VAN-HANH-NHIEU-KHO, đợt 3)
--
-- VÌ SAO CẦN: 12 mục kiểm hiện có trả lời "LÚC NÀY có gì hỏng", nhưng không
-- nhớ gì. Trang Tình trạng chạy kiểm ngay lúc mở, nên sự cố xảy ra lúc 2 giờ
-- sáng rồi tự khỏi lúc 3 giờ là không để lại dấu vết nào. Với nhiều kho,
-- platform cần trả lời được: sự cố này bắt đầu từ bao giờ, kéo dài bao lâu,
-- lặp bao nhiêu lần, đã có ai nhận chưa, đã hết chưa.
--
-- MỖI DÒNG LÀ MỘT SỰ CỐ, KHÔNG PHẢI MỘT LẦN KIỂM. Camera rớt mạng suốt đêm là
-- MỘT dòng với `occurrence_count` tăng dần — không phải một dòng mỗi 15 phút.
-- Không gom như vậy thì sổ ngộp đúng như `agent_log_events` (26.990 dòng một
-- tuần cho một kho, 77% nhiễu) rồi không ai mở.
--
-- `issue_key` LÀ ĐÚNG MÃ CỦA MỤC TRÊN TRANG "CẦN CHÚ Ý" (`buildIssues` trong
-- src/lib/system/status-view.ts): `<mục kiểm>:<id đối tượng>` hoặc chỉ
-- `<mục kiểm>` cho mục cấp hệ thống. Sổ ghi đúng danh sách trang đang hiện —
-- trang và sổ không bao giờ nói hai câu khác nhau.
--
-- AI GHI: chỉ route tự kiểm nền `/api/system/check` (service role). Trang
-- Tình trạng chỉ ĐỌC. Không có policy RLS nào → chỉ service role chạm được
-- bảng; khách thuê không đọc được sự cố của mình lẫn của người khác. Chủ dự
-- án chưa chốt có mở cho khách xem không (kế hoạch, phần 0, quyết định #2);
-- mặc định đóng — mở sau thì thêm policy, không phải sửa dữ liệu.
--
-- Chạy lại nhiều lần vẫn cho cùng kết quả.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.warehouse_incidents (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Mã ổn định của "cái gì hỏng ở đâu" — đúng `SystemIssue.id`.
  issue_key        text        NOT NULL,
  check_key        text        NOT NULL,

  -- NULL = sự cố cấp hệ thống (cron, VPS), không thuộc shop nào.
  organization_id  uuid        NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Id đối tượng (agent / camera / tổ chức) — NULL cho mục cấp hệ thống.
  -- Lưu riêng để quyết định đóng sự cố tra thẳng được đối tượng trong lượt
  -- kiểm mới, không phải bóc chuỗi issue_key.
  entity_id        text        NULL,

  -- Chỉ crit / warn. "Chưa đo được" KHÔNG phải sự cố: mạng chập một nhịp
  -- không được mở dòng mới, và không được đóng dòng cũ (không có bằng
  -- chứng là đã khỏi). Xem src/lib/system/incidents.ts.
  severity         text        NOT NULL CHECK (severity IN ('crit', 'warn')),
  -- Mức nặng nhất từng thấy trong đời sự cố — "đã có lúc crit chưa".
  peak_severity    text        NOT NULL CHECK (peak_severity IN ('crit', 'warn')),

  -- Ảnh chụp chữ tại lần thấy gần nhất. Lưu chữ chứ không chỉ lưu id: tên kho,
  -- tên camera đổi được, còn sổ phải đọc được y như lúc sự cố xảy ra.
  where_label      text        NOT NULL,
  what_label       text        NOT NULL,
  symptom          text        NOT NULL,
  action           text        NOT NULL,

  status           text        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open', 'acknowledged', 'resolved')),

  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  occurrence_count integer     NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),

  acknowledged_at  timestamptz NULL,
  acknowledged_by  uuid        NULL,

  resolved_at      timestamptz NULL,
  -- auto_ok      : mục kiểm thấy đối tượng khoẻ lại (bằng chứng dương)
  -- out_of_scope : đối tượng không còn được theo dõi (camera lưu trữ, tổ
  --                chức tắt theo dõi) — không phải "đã khỏi"
  -- manual       : người trực đóng tay (đợt 4)
  resolved_reason  text        NULL
                               CHECK (resolved_reason IS NULL
                                      OR resolved_reason IN ('auto_ok', 'out_of_scope', 'manual')),

  -- Đã đóng thì phải có giờ đóng và lý do; chưa đóng thì không được có.
  CONSTRAINT warehouse_incidents_resolved_consistent CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL AND resolved_reason IS NOT NULL)
  ),
  CONSTRAINT warehouse_incidents_seen_order CHECK (last_seen_at >= first_seen_at)
);

-- MỘT sự cố đang mở cho mỗi `issue_key`. Hai lượt tự kiểm chồng nhau (timer
-- chạy bù sau khi VPS khởi động lại) không đẻ ra hai dòng cho cùng một chuyện.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_incidents_one_active_per_issue
  ON public.warehouse_incidents (issue_key)
  WHERE status IN ('open', 'acknowledged');

-- Trang Sự cố: đang mở, nặng trước, mới nhất trước.
CREATE INDEX IF NOT EXISTS warehouse_incidents_active_idx
  ON public.warehouse_incidents (status, severity, last_seen_at DESC);

-- Lọc theo shop.
CREATE INDEX IF NOT EXISTS warehouse_incidents_org_idx
  ON public.warehouse_incidents (organization_id, status);

ALTER TABLE public.warehouse_incidents ENABLE ROW LEVEL SECURITY;
-- Cố ý KHÔNG tạo policy nào: chỉ service role (route tự kiểm, API platform)
-- đọc/ghi được. Xem ghi chú đầu file.

COMMENT ON TABLE public.warehouse_incidents IS
  'Sổ sự cố: mỗi dòng một sự cố (không phải một lần kiểm), gom theo issue_key = SystemIssue.id của trang Cần chú ý. Chỉ route /api/system/check ghi. Không có policy RLS — chỉ service role.';
COMMENT ON COLUMN public.warehouse_incidents.issue_key IS
  'Đúng SystemIssue.id: "<check_key>:<id đối tượng>" hoặc "<check_key>" cho mục cấp hệ thống.';
COMMENT ON COLUMN public.warehouse_incidents.occurrence_count IS
  'Số lượt tự kiểm đã thấy sự cố này (mỗi 15 phút một lượt), không phải số lần sự việc xảy ra.';

COMMIT;
