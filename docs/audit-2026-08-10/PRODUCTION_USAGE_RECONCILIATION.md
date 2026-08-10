# PRODUCTION_USAGE_RECONCILIATION — 10/08/2026

Đối chiếu ước lượng từ source code với số đo thật. Chỗ nào không lấy được thì
ghi `NOT OBSERVABLE`.

---

## 1. Số đo Vercel

### 1.1 Project cũ, 30 ngày trước khi bị khoá (ảnh chụp)

| Chỉ số | Đo được | Hạn mức Hobby |
|---|---|---|
| Function Invocations | 2.300.000 | 1.000.000 |
| Edge Requests | 1.100.000 | 1.000.000 |
| Fluid Active CPU | 12h11m | 4h |
| Fluid Provisioned Memory | 511,3 GB-Hrs | 360 GB-Hrs |
| Fast Origin Transfer | 5,14 GB | 10 GB |
| Fast Data Transfer | 2,87 GB | 100 GB |
| ISR Reads | 615 | 1.000.000 |

### 1.2 Đối chiếu với ước lượng từ code

Ước lượng (2 agent + 1 dashboard 8h/ngày, theo REQUEST_INVENTORY §6):

```
agent:      2 × 1.123.200 = 2.246.400
dashboard:  331.200  (nhịp CŨ trước hotfix: ~1.483.200)
```

Với nhịp cũ: 2.246.400 + 1.483.200 ≈ **3,73 triệu HTTP request**, trong khi
Vercel đếm **1,1 triệu Edge Requests** và **2,3 triệu Invocations**.

**Chênh lệch chưa giải thích được.** Ba khả năng, chưa loại trừ được cái nào:

1. Hai agent **không** chạy đủ 30 ngày (tài khoản bị khoá ngày 08/08, và
   trước đó có thể có giai đoạn agent tắt).
2. Dashboard không mở 8h/ngày như giả định.
3. Cách Vercel đếm Edge Request khác với "mỗi HTTP request từ client".

→ `NOT OBSERVABLE`: breakdown theo endpoint. Không suy ra được từ tổng.

**Việc cần làm để đóng khoảng trống này:** mở Vercel → Observability → lọc
theo path, lấy top endpoint theo số invocation trong 24h. Đây là dữ liệu
**duy nhất** cho phép khẳng định nguồn nào thật sự đắt nhất; mọi thứ trong
REQUEST_INVENTORY vẫn là suy từ code.

### 1.3 Project mới (đang chạy, cửa sổ vừa reset)

| Chỉ số | Đo được |
|---|---|
| Function Invocations | 921 |
| Edge Requests | 811 |
| Fluid Active CPU | 28s |
| Fluid Provisioned Memory | 0,03 GB-Hrs |

Cửa sổ quá ngắn, chưa dùng để kết luận. Nhưng **hữu ích**: đây là mốc sạch để
đo lại sau 48h với đúng cấu hình hiện tại.

---

## 2. Tỷ lệ Invocation / Edge Request

| Lần đo | Invocations | Edge Requests | Tỷ lệ |
|---|---|---|---|
| Sự cố | 2.300.000 | 1.100.000 | 2,09 |
| Project mới | 921 | 811 | 1,14 |

Không ổn định → **không dùng hệ số cố định trong capacity model**.
CAPACITY_MODEL đếm HTTP request và ghi rõ khoảng nhân 1,1–2,1.

---

## 3. Số đo Supabase

### 3.1 Lệnh gửi xuống agent — 30 ngày

Truy vấn đã chạy (`agent_commands`, `taken_at is not null`):

| Loại lệnh | n | p50 (s) | p95 (s) | max (s) |
|---|---|---|---|---|
| `cut_clip` | 19 | 1,56 | 2,77 | 2,91 |
| `probe_codec` | 13 | 1,42 | 2,71 | 2,92 |
| `start_recording` | 13 | 1,61 | 3,06 | 3,49 |
| `discover_lan` | 11 | 2,38 | 2,94 | 3,01 |
| `test_camera_connection` | 10 | 1,25 | 2,65 | 2,73 |
| `stop_recording` | 1 | 0,96 | — | 0,96 |
| **Tổng** | **67** | | | |

Phân bố khớp chính xác nhịp poll 3 giây (chờ đều 0–3s + round trip).

**Con số đắt nhất của cả đợt audit:**

> 864.000 request để giao **67** lệnh = **12.900 request cho mỗi lệnh**.

**Cảnh báo về tính đại diện:** 30 ngày này **bao gồm** 47 giờ hệ thống chết
(08/08 05:16 → 10/08 04:xx) và giai đoạn cấu hình/thử nghiệm. Số lệnh của một
tháng vận hành bình thường có thể cao hơn — nhưng khó cao hơn **hai bậc**, nên
kết luận "poll đắt gấp hàng nghìn lần giá trị nó chở" vẫn đứng vững.

Cần chạy lại sau 30 ngày vận hành liên tục để xác nhận.

### 3.2 Trạng thái hiện tại (đo được)

| Chỉ số | Giá trị |
|---|---|
| Kho | 2 |
| Agent active | 2 |
| Camera active | 3 |
| Phiên đang ghi | 1 |

### 3.3 Thông báo Lark — 30 ngày

| event_type | status | n | Nguồn |
|---|---|---|---|
| `digest_daily` | sent | 43 | **pg_cron trong Supabase** |
| `digest_weekly` | sent | 8 | pg_cron |
| `digest_monthly` | sent | 2 | pg_cron |
| `packing_issue_duplicated` | sent | 13 | **Vercel** |
| `packing_issue_no_active_session` | sent | 13 | Vercel |
| `packing_issue_*` | suppressed | 12 | Vercel (gộp cửa sổ) |
| `connection_test` | failed/sent | 4/3 | Vercel |

**Bằng chứng cứng rằng đường Supabase-thuần đã tồn tại và chạy được:** ba loại
`digest_*` vẫn gửi thành công **trong lúc Vercel trả 402**, tin gần nhất
10/08 01:00 UTC. Chúng chạy từ pg_cron, không đụng Vercel.

Đây là tiền lệ quan trọng cho ARCHITECTURE_OPTIONS §G.

### 3.4 Chưa lấy được

| Chỉ số | Trạng thái | Lý do |
|---|---|---|
| Số dòng `camera_recording_files`/ngày | `NOT OBSERVABLE` | MCP mất kết nối giữa phiên |
| Supabase API request/tháng | `NOT OBSERVABLE` | Chưa mở trang usage Supabase |
| Storage egress (xem clip) | `NOT OBSERVABLE` | — |
| Realtime đang dùng ở đâu | `NOT OBSERVABLE` | Chưa rà |
| Danh sách pg_cron job | `NOT OBSERVABLE` | MCP mất kết nối |
| Dashboard active hours thật | `NOT OBSERVABLE` | Không có telemetry client |
| Số tab mở đồng thời | `NOT OBSERVABLE` | Không có telemetry client |
| Tỷ lệ lỗi/retry của agent | `NOT OBSERVABLE` | Log agent nằm trên máy kho, chưa đẩy về |

Mục cuối đáng chú ý: `agent_probe_report_failed` và
`warehouse_activity_fetch_failed` **chưa có đường ghi nhận** — đúng cọc P1 đã
nêu. Hiện không phân biệt được "không có lỗi" với "không đo được lỗi".

---

## 4. Bằng chứng vận hành thu được ngoài lề

Sự cố 08–10/08 cho ba dữ kiện có giá trị lâu dài:

1. **Hàng đợi scan không mất dữ liệu** — 47 giờ mất kết nối, JSONL append-only
   không giới hạn ([queue.ts](../../warehouse-agent/src/queue.ts)).
2. **Agent retry vô hạn, không bỏ cuộc** —
   [index.ts:1322-1338](../../warehouse-agent/src/index.ts#L1322-L1338).
3. **`last_seen_at` không đo được agent khi route lỗi sớm** — route thoát ở
   bước tra `warehouse_agents` trước khi ghi
   ([poll-commands/route.ts:99](../../src/app/api/agent/poll-commands/route.ts#L99)).
   Suy ra: **`last_seen_at` là chỉ báo liveness không đáng tin khi cloud lỗi.**
   Cần một tín hiệu độc lập nếu muốn giám sát agent nghiêm túc.
