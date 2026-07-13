# Lark notify — verify đo bằng dữ liệu thật

## Bật đúng thứ tự

1. **Deploy** với `LARK_NOTIFY_ENABLED=true` + `NEXT_PUBLIC_APP_URL=https://<domain>`.
   - Chưa set env = tắt (mặc định an toàn) → deploy trước không rủi ro.
2. **Cấu hình MỘT kho** (không phải tất cả):
   ```sql
   UPDATE public.warehouses
   SET notify_lark_webhook_url = 'https://open.larksuite.com/open-apis/bot/v2/hook/<token>',
       notify_lark_enabled = true
   WHERE id = '<uuid kho test>';
   ```
3. **Verify nửa dương THỦ CÔNG trong ~1 giờ đầu**: quét trùng 1 mã (hoặc quét khi không có ca mở) → mở nhóm Lark kiểm:
   - Tin có tới không?
   - Đúng tên kho (prefix `[<tên kho>]`)?
   - Có mã waybill cụ thể?
   - Có link `Kiểm tra: <APP_URL>/dashboard/videos`?
   - Không spam (quét trùng lần 2, 3 trong 5 phút → KHÔNG có tin mới).

   **SAI bất kỳ điểm nào → tắt env `LARK_NOTIFY_ENABLED=false` NGAY** (đừng để 2 ngày spam vào nhóm thật → đội mute → tính năng chết trước khi kịp sửa). Fix → verify lại → mới thả 1-2 ngày.

4. **Chạy 1-2 ngày** → chạy 4 vế SQL bên dưới. Mọi vế phải khớp:

## Vế 1: DB nội bộ nhất quán

Mỗi cửa sổ 5 phút có lỗi thật (packing_events.status bất thường) PHẢI có đúng 1 row `sent` trong notification_logs cho (warehouse, event_type, window).

Chạy trong Supabase SQL Editor:

```sql
-- So cửa sổ có lỗi vs cửa sổ có sent, cho 1 warehouse cụ thể, 48h gần nhất.
-- Thay :warehouse_id = UUID kho đang bật Lark.
WITH windows_with_errors AS (
  SELECT
    warehouse_id,
    -- Nhóm lỗi theo cửa sổ 5 phút (300s). Phải khớp LARK_CONFIG.windowSeconds.
    date_trunc('minute', scanned_at)
      - MAKE_INTERVAL(mins => MOD(EXTRACT(minute FROM scanned_at)::int, 5)) AS window_start,
    CASE status
      WHEN 'duplicated' THEN 'packing_issue_duplicated'
      WHEN 'no_active_session' THEN 'packing_issue_no_active_session'
      WHEN 'unmapped_scanner' THEN 'packing_issue_unmapped_scanner'
      WHEN 'invalid_code' THEN 'packing_issue_invalid_code'
    END AS event_type,
    COUNT(*) AS error_count
  FROM public.packing_events
  WHERE warehouse_id = :warehouse_id
    AND scanned_at > now() - interval '48 hours'
    AND status IN ('duplicated','no_active_session','unmapped_scanner','invalid_code')
  GROUP BY 1, 2, 3
),
sent_windows AS (
  SELECT warehouse_id, window_start, event_type, COUNT(*) AS sent_count
  FROM public.notification_logs
  WHERE warehouse_id = :warehouse_id
    AND sent_at > now() - interval '48 hours'
    AND status = 'sent'
  GROUP BY 1, 2, 3
)
SELECT
  COALESCE(w.window_start, s.window_start) AS window_start,
  COALESCE(w.event_type, s.event_type) AS event_type,
  COALESCE(w.error_count, 0) AS errors_actual,
  COALESCE(s.sent_count, 0) AS sent_actual,
  CASE
    WHEN w.error_count > 0 AND COALESCE(s.sent_count, 0) = 0 THEN 'MISSING_SENT'
    WHEN w.error_count > 0 AND s.sent_count > 1 THEN 'EXTRA_SENT'
    WHEN COALESCE(w.error_count, 0) = 0 AND s.sent_count > 0 THEN 'PHANTOM_SENT'
    ELSE 'OK'
  END AS verdict
FROM windows_with_errors w
FULL OUTER JOIN sent_windows s
  ON w.warehouse_id = s.warehouse_id
  AND w.window_start = s.window_start
  AND w.event_type = s.event_type
WHERE COALESCE(w.error_count, 0) > 0 OR COALESCE(s.sent_count, 0) > 0
ORDER BY window_start DESC, event_type;
```

**Kỳ vọng: mọi row verdict = `OK`.**

- `MISSING_SENT` = cửa sổ có lỗi thật mà không có `sent` → **`after()` không cứu được** hoặc bug khác. Nghiêm trọng.
- `EXTRA_SENT` = 1 cửa sổ có 2 `sent` → UNIQUE index không ăn (không thể xảy ra nếu UNIQUE đúng).
- `PHANTOM_SENT` = có `sent` mà không có lỗi → bug trigger sai.

## Vế 2: DB nhất quán với Lark thật

Đếm `sent` trong DB rồi đếm tay số tin **thấy trong nhóm Lark**. Hai số phải bằng nhau.

```sql
SELECT
  event_type,
  COUNT(*) AS sent_in_db
FROM public.notification_logs
WHERE warehouse_id = :warehouse_id
  AND sent_at > now() - interval '48 hours'
  AND status = 'sent'
GROUP BY event_type
ORDER BY event_type;
```

**Đối chiếu:** mở nhóm Lark → đếm tin bot đã gửi 48h qua (có thể lọc theo tiền tố `[<tên kho>]`).

- DB `sent` = Lark thấy → OK.
- DB `sent` > Lark thấy → **fetch tới Lark chết SAU KHI ghi log `sent`**. Kiểm `notification_logs.status='failed'` xem có row nào không (không có mà tin vẫn mất = bug tinh vi hơn — có thể là lambda kill giữa update `sent → failed`).
- DB `sent` < Lark thấy → không thể xảy ra (log ghi trước fetch).

## Vế 3: Row `failed` có `error_message` (biết vì sao rơi)

```sql
SELECT event_type, error_message, COUNT(*) AS n
FROM public.notification_logs
WHERE warehouse_id = :warehouse_id
  AND sent_at > now() - interval '48 hours'
  AND status = 'failed'
GROUP BY event_type, error_message
ORDER BY n DESC;
```

- Mọi row `failed` phải có `error_message` không null (client.ts luôn ghi khi fail).
- Xem tỉ lệ + loại error (`fetch_error:` / `http_4xx:` / `http_5xx:`) — nếu 4xx nhiều = webhook URL/token sai; 5xx nhiều = Lark side.

## Vế 4: Row kẹt `pending` > N phút — ĐO TRỰC TIẾP `after()` có cứu không

Đây là vế QUAN TRỌNG NHẤT của thiết kế `pending → sent/failed`. Flow:
1. `INSERT status='pending'` claim slot cửa sổ.
2. `fetch()` gọi Lark.
3. `UPDATE status='sent'/'failed'` sau khi fetch trả kết quả.

Nếu lambda serverless bị kill giữa bước 2 (fetch chưa xong) → row **kẹt `pending`**. Đếm số row này = tần suất `after()` KHÔNG cứu được.

```sql
-- Row kẹt pending > 2 phút (đủ dư cho fetch 5s + safety margin lớn).
SELECT
  warehouse_id,
  event_type,
  window_start,
  sent_at,
  waybill_code,
  now() - sent_at AS stuck_for
FROM public.notification_logs
WHERE warehouse_id = :warehouse_id
  AND sent_at > now() - interval '48 hours'
  AND status = 'pending'
  AND sent_at < now() - interval '2 minutes'
ORDER BY sent_at DESC
LIMIT 100;
```

**Kỳ vọng: 0 row** (hoặc rất ít <1% tổng sent+failed).
- `after()` hoạt động → gần như 0 row pending kẹt (fetch chạy xong, UPDATE thành sent/failed).
- Nhiều row pending kẹt → **`after()` không cứu**, lambda vẫn kill giữa fetch → cần cách khác (retry queue, DB reaper).

Kết hợp với Vế 2: nếu DB `sent` > Lark thấy VÀ vế 4 nhiều pending → giải thích trực tiếp (lambda kill giữa fetch). Nếu DB `sent` > Lark thấy VÀ vế 4 sạch → bug tinh vi hơn (log ghi sent nhưng Lark thật ra chưa nhận — kiểm response body).

**Vế 4 là vế quan trọng nhất — nó đo GIẢ ĐỊNH KIẾN TRÚC, không chỉ tính năng Lark:**
- Gần 0 pending kẹt → `after()` đáng tin → fire-and-forget an toàn trên serverless → **kết luận áp dụng cho cả các route khác** trong tương lai (audit log, analytics, cleanup phụ...).
- Nhiều pending kẹt → **mọi việc-sau-response trên hệ đều không đáng tin** → phải xử rộng hơn (queue infra, cron reaper). Đây là tin xấu rộng hơn Lark.

## Cạnh cứng

- Query trên nhóm cửa sổ 5 phút bằng `MOD(minute, 5)`. Nếu tăng `LARK_CONFIG.windowSeconds` khỏi 300s, phải sửa query.
- Chỉ chạy sau khi đã có ≥ 1 ngày dữ liệu. Ít quá không đủ tin cậy.
- Không đối chiếu qua `packing_events.status='valid'` — không bắn tin cho status này.

## Cọc đã biết (không phải bug — hoãn có ý thức)

**Link trong tin KHÔNG filter theo warehouse/status.** Quản lý bấm link tới `/dashboard/videos` sẽ thấy TOÀN BỘ video, phải tự tìm mã cụ thể trong danh sách. Bù lại: **tin có liệt kê mã waybill cụ thể** (max 10 mã + "+N khác") — quản lý đọc tin đã biết mã nào lỗi, tra thẳng trên dashboard hoặc trên sàn.

Nếu dùng thật thấy vướng (mã bị nén > 10, hoặc không thấy trong dashboard vì filter mặc định `scan_status=valid`) → làm filter (~1 ngày):
1. Sửa API `/api/order-proof/scans` mở whitelist `scan_status` cho 3 status problem (`no_active_session`, `unmapped_scanner`, `invalid_code`).
2. Sửa client `/dashboard/videos` đọc `useSearchParams` lúc mount → set state filter.
3. Link Lark build kèm `?warehouse_id=X&scan_status=duplicated&from=<window_start>`.
