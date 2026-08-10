# REQUEST_INVENTORY — Betabox, 10/08/2026

Audit READ-ONLY. Không đổi runtime, không đổi interval.

Mọi con số đều kèm `file:line` hoặc truy vấn. Chỗ nào chưa đo được ghi
`NOT OBSERVABLE`, không quy về 0.

Quy ước tính: 1 tháng = 30 ngày = 2.592.000 giây.

---

## 0. Cảnh báo về đơn vị đo

**Một HTTP request KHÔNG bằng một Function Invocation.** Bằng chứng từ chính
số liệu của tài khoản:

| Lần đo | Function Invocations | Edge Requests | Tỷ lệ |
|---|---|---|---|
| Sự cố (30 ngày, ảnh chụp) | 2.300.000 | 1.100.000 | **2,09** |
| Project mới (mới chạy) | 921 | 811 | **1,14** |

Hai tỷ lệ khác nhau nên **không suy ra được hệ số ổn định**. Giả thuyết hợp lý
là mỗi request đi qua proxy sinh thêm một invocation (proxy + route), còn
request tới asset tĩnh chỉ tính Edge Request — nhưng chưa xác minh được.

→ `NOT OBSERVABLE`: bản đồ chính xác request → invocation. Cần mở Vercel
Observability, xem breakdown theo function. Toàn bộ bảng dưới đây đếm **HTTP
request**, chưa nhân hệ số.

---

## 1. Agent — nguồn định kỳ (per agent)

| # | Nguồn | file:line | Endpoint | Nhịp | Idle req/tháng | Ghi chú |
|---|---|---|---|---|---|---|
| A1 | poll-commands | [index.ts:1626](../../warehouse-agent/src/index.ts#L1626), default [config.ts:45](../../warehouse-agent/src/config.ts#L45) | `/api/agent/poll-commands` | 3s | **864.000** | 80% tải agent |
| A2 | heartbeat | [index.ts:1625](../../warehouse-agent/src/index.ts#L1625), [config.ts:37](../../warehouse-agent/src/config.ts#L37) | `/api/warehouse/heartbeat` | 30s | 86.400 | Xem §5 — thừa |
| A3 | camera-probe | [index.ts:1681](../../warehouse-agent/src/index.ts#L1681), [config.ts:52](../../warehouse-agent/src/config.ts#L52) | `/api/agent/camera-probe` | 30s | 86.400 | Đã gộp all_active vào response (`21081d4` trở về trước) |
| A4 | discovery | [index.ts:1622](../../warehouse-agent/src/index.ts#L1622) | `/api/warehouse/discovery` | 60s | 43.200 | Danh sách cổng COM |
| A5 | scan queue flush | [index.ts:1734](../../warehouse-agent/src/index.ts#L1734) | `/api/warehouse/scans` | 5s | **0** khi rỗng | Chỉ chạy khi hàng đợi có item |
| A6 | log-events flush | [remote-logger.ts:94](../../warehouse-agent/src/remote-logger.ts#L94) | `/api/agent/log-events` | 30s | **0** khi rỗng | Điều kiện `queue.length > 0` |
| | **Cộng định kỳ** | | | | **1.080.000** | |

Hai nhịp A5/A6 gác điều kiện rỗng nên không tốn gì lúc bình thường — đúng
thiết kế, không phải chỗ cần sửa.

---

## 2. Agent — nguồn theo sự kiện (trục tăng trưởng)

Đây là phần **thiếu hoàn toàn** trong các ước lượng trước.

| # | Nguồn | file:line | Endpoint | Kích hoạt | Tăng theo |
|---|---|---|---|---|---|
| B1 | **Báo segment** | [segment-index.ts:120](../../warehouse-agent/src/segment-index.ts#L120) → [:327](../../warehouse-agent/src/segment-index.ts#L327) | `/api/agent/recording-files` | mỗi lần ffmpeg đóng file | **camera đang ghi** |
| B2 | scan vận đơn / QR | [sender.ts:40](../../warehouse-agent/src/sender.ts#L40) | `/api/warehouse/scans` | mỗi lượt quét | sản lượng kho |
| B3 | recording-credentials | [commands.ts:119](../../warehouse-agent/src/commands.ts#L119), [:157](../../warehouse-agent/src/commands.ts#L157) | `/api/agent/recording-credentials` | boot + long-retry 5' + warm cache | camera lỗi |
| B4 | recording-status | [commands.ts:209](../../warehouse-agent/src/commands.ts#L209) | `/api/agent/recording-status` | đổi trạng thái ghi | sự cố camera |
| B5 | chuỗi cắt clip | [commands.ts:387](../../warehouse-agent/src/commands.ts#L387), [:425](../../warehouse-agent/src/commands.ts#L425), [:475](../../warehouse-agent/src/commands.ts#L475), [:521](../../warehouse-agent/src/commands.ts#L521) | 4 endpoint | mỗi clip | số clip |
| B6 | upload file clip | [upload.ts:141](../../warehouse-agent/src/upload.ts#L141) | **Supabase Storage trực tiếp** | mỗi clip | **KHÔNG qua Vercel** |
| B7 | boot-declare | [boot-declare.ts:29](../../warehouse-agent/src/boot-declare.ts#L29) | `/api/agent/boot-declare` | mỗi lần khởi động | restart |
| B8 | recovery segment | [segment-index.ts:200](../../warehouse-agent/src/segment-index.ts#L200) | `/api/agent/recording-files/known` | boot | restart |
| B9 | verify stale clip | [stale-recovery.ts:91](../../warehouse-agent/src/stale-recovery.ts#L91) | `/api/agent/verify-clip-stale-marker` | phát hiện clip treo | sự cố |

### B1 là phát hiện lớn nhất của đợt rà này

Segment dài **60 giây**, do cloud quyết định:
[active-credentials.ts:77](../../src/lib/camera/active-credentials.ts#L77) trả
`segment_seconds: 60`.

[segment-index.ts:327-353](../../warehouse-agent/src/segment-index.ts#L327-L353)
gửi **ngay**, không gom theo lô — `BATCH_SIZE = 50` chỉ cắt lô khi một sự kiện
sinh ra >50 payload, chuyện không xảy ra lúc chạy bình thường (mỗi lần cuộn
file = 1 payload).

→ **Một camera ghi 24/7 = 43.200 request/tháng.**

Đây là trục tăng **theo camera**, không theo kho. Kho 8 camera tốn nhiều
request cho riêng việc báo segment hơn cả `heartbeat` + `probe` + `discovery`
cộng lại.

`NOT OBSERVABLE` (phiên này): số dòng thật trong `camera_recording_files` —
Supabase MCP mất kết nối giữa chừng (`select 2 as ok` cũng timeout), nên
không xác minh được bằng dữ liệu. Truy vấn cần chạy lại:

```sql
select created_at::date, count(*), count(distinct camera_id)
from camera_recording_files
where created_at > now() - interval '14 days'
group by 1 order by 1 desc;
```

---

## 3. Agent — hành vi khi lỗi

| Cơ chế | file:line | Tác động lên số request |
|---|---|---|
| `fetchWithRetry` maxAttempts = 4 | [fetch-error.ts:137](../../warehouse-agent/src/fetch-error.ts#L137) | tối đa **×4** |
| Backoff 500ms × 3 | [fetch-error.ts:138-139](../../warehouse-agent/src/fetch-error.ts#L138-L139) | 500 / 1500 / 4500ms |
| Chỉ retry lỗi **mạng** | [fetch-error.ts:58-68](../../warehouse-agent/src/fetch-error.ts#L58-L68) | ECONNRESET, ETIMEDOUT, EAI_AGAIN… |

**Quan trọng:** HTTP 4xx/5xx **không** kích retry — chúng là response hợp lệ,
không throw. Nên sự cố 402/500 vừa rồi **không** nhân 4 lần lưu lượng. Chỉ đứt
mạng/DNS mới nhân.

`pollOnce` không có circuit breaker
([index.ts:1322-1338](../../warehouse-agent/src/index.ts#L1322-L1338)) — hỏng
thì bỏ qua nhịp đó và thử lại nhịp sau, mãi mãi. Log gộp qua rate-limiter nên
không phình.

---

## 4. Web — polling phía trình duyệt

| # | Nguồn | file:line | Nhịp | Gate visibility | Req/giờ (1 tab hiện) |
|---|---|---|---|---|---|
| W1 | operations → `live/overview` | [operations/page.tsx:31](../../src/app/dashboard/operations/page.tsx#L31) | 3s | ✅ | 1.200 |
| W2 | operations → proof-size-risk | [operations/page.tsx:36](../../src/app/dashboard/operations/page.tsx#L36) | 60s | ✅ | 60 |
| W3 | CodecWarningBanner (**layout — mọi trang**) | [CodecWarningBanner.tsx:26](../../src/components/camera/CodecWarningBanner.tsx#L26) | 30s | ✅ | 120 |
| W4 | dashboard tổng quan | [dashboard/page.tsx:123](../../src/app/dashboard/page.tsx#L123) | 30s | ✅ | 120 |
| W5 | devices | [devices/page.tsx:304](../../src/app/dashboard/devices/page.tsx#L304) | 7s | ✅ (tự cài) | 514 |
| W6 | videos | [videos/page.tsx:439](../../src/app/dashboard/videos/page.tsx#L439) | 15s | ✅ (`document.hidden`) | 240 |
| W7 | ImpersonateWatcher | [ImpersonateWatcher.tsx:26](../../src/components/platform/ImpersonateWatcher.tsx#L26) | 30s | ✅ | 120 **chỉ khi impersonate** |
| W8 | **`/watch` — trang khách xem clip** | [use-watch-clip-state.ts:39](../../src/lib/watch/use-watch-clip-state.ts#L39) | **2s** active / 5s đơn mở / 20s offline | ❌ chưa rà | **1.800** |
| W9 | warehouses | [warehouses/page.tsx:599](../../src/app/dashboard/warehouses/page.tsx#L599) | 60s | — | **0** (chỉ `setNow` cục bộ, không fetch) |

**W8 chưa từng được nhắc trong các đợt trước.** Nhịp 2 giây, và nó nằm ở trang
**người dùng cuối xem bằng chứng**, nên tăng theo *số người xem* chứ không theo
số kho. Cần rà riêng: có gate visibility không, có dừng khi clip đã ready không.

Chỉ một trang dashboard mở: **W1+W2+W3 = 1.380 req/giờ**.
Mở 8h/ngày → **331.200/tháng**. Mở và hiện 24/7 → **993.600/tháng**.

Nhiều tab nhân tuyến tính — không có cơ chế chia sẻ giữa tab (không dùng
BroadcastChannel/SharedWorker).

---

## 5. Dư thừa đã xác định

**`heartbeat` (A2) trùng chức năng với `poll-commands` (A1).** Comment ở
[heartbeat/route.ts:13-20](../../src/app/api/warehouse/heartbeat/route.ts#L13-L20)
ghi mục đích là "để dashboard biết agent còn sống", nhưng
[poll-commands/route.ts:160-168](../../src/app/api/agent/poll-commands/route.ts#L160-L168)
**đã** cập nhật `last_seen_at` mỗi 3 giây.

Phần riêng còn lại của heartbeat: `time_drift_seconds`, `retention_days`,
`watchdog_last_tick_ms_ago` — không cái nào cần nhịp 30 giây.

---

## 6. Tổng hợp — một agent, một tháng

| Nhóm | Request |
|---|---|
| Định kỳ (A1–A4) | 1.080.000 |
| Segment, 1 camera ghi 24/7 (B1) | 43.200 |
| Segment, mỗi camera thêm | +43.200 |
| Scan, clip, status (B2–B5) | theo sản lượng, xem CAPACITY_MODEL |
| **1 agent + 1 camera, idle** | **≈ 1.123.200** |

Hiện trạng production (đo được): 2 agent active, 3 camera active, 1 phiên đang
ghi, 2 kho.
