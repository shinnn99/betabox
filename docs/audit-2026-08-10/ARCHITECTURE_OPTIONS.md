# ARCHITECTURE_OPTIONS — Betabox, 10/08/2026

Không implement phương án nào trong đợt này. Số request tính cho **10 kho,
vận hành bình thường** (CAPACITY_MODEL §4 = 15,2 triệu/tháng làm mốc).

---

## Bảng đối chiếu

| | Phương án | Req/tháng (10 kho) | Độ trễ lệnh | Failure mode | Độ phức tạp | Rủi ro migration |
|---|---|---|---|---|---|---|
| A | Giữ 3s | 15.200.000 | ~1,6s | đã biết, ổn định | 0 | 0 |
| B | Adaptive 10s | 8.000.000 | ≤10s | như A | thấp | thấp |
| C | Adaptive 30s | 6.000.000 | ≤30s | như A | thấp | thấp |
| D | Gộp/bỏ nhịp thừa | 13.700.000 | không đổi | như A | thấp | thấp |
| E | Realtime thay poll | ~1.500.000 | <1s | **mất kết nối = mất lệnh** | cao | cao |
| **F** | **Realtime + poll chậm 60s** | **~2.900.000** | **<1s** | **poll đỡ** | trung bình | trung bình |
| G | Agent gọi Supabase trực tiếp | ~2.000.000 | <1s | phụ thuộc RLS đúng | cao | **cao** |
| H | Dashboard event-driven | −3.300.000 | tức thì | fallback poll | trung bình | thấp |

---

## A. Giữ nguyên 3s

Không làm gì. Hoá đơn tuyến tính theo số kho, 57% là để hỏi "có lệnh chưa?".
Chấp nhận được ở 2 kho trên gói Pro; không chấp nhận được nếu Betabox thành
dịch vụ bán cho nhiều khách.

## B / C. Adaptive backoff

Nhận lệnh → chuyển về 3s trong ~2 phút; rảnh thì lùi về 10s (B) hoặc 30s (C).
Vì lệnh cực hiếm (67 lệnh/30 ngày — PRODUCTION_USAGE_RECONCILIATION §3.1),
agent gần như luôn ở nhịp rảnh.

- **Ưu**: sửa một chỗ, không đổi giao thức, không đổi hạ tầng.
- **Nhược**: đổi thẳng tiền lấy độ trễ trước mặt người vận hành. Không giải
  quyết gốc — vẫn hỏi-dò, chỉ hỏi thưa hơn.
- Không phương án nào đưa 10 kho về dưới mức hợp lý.

## D. Gộp/bỏ nhịp thừa — ⚠️ ĐÃ SỬA: KHÔNG độc lập với F

> **Đính chính 10/08 (AUDIT_CLOSURE Gate 3).** Bản đầu gọi heartbeat là "thừa
> tuyệt đối" và khuyên "làm ngay bất kể chọn gì". **Sai.** Kết luận đó chỉ nhìn
> `last_seen_at` được *ghi* ở đâu, không nhìn nó được *đọc* ở đâu.
>
> `last_seen_at` là phụ thuộc **chức năng**: 5 route đọc nó để quyết định có
> cho phép ra lệnh không (start/stop recording, probe-codec, test-connection,
> recording/status), ngưỡng **60 giây**.
>
> Bỏ heartbeat + giãn poll fallback lên 60s ⇒ độ tươi `last_seen_at` chạm đúng
> ngưỡng 60s ⇒ dao động qua ranh giới ⇒ bấm "Bắt đầu ghi" đôi lúc bị từ chối vì
> cloud tưởng agent đã chết.
>
> **Không bỏ heartbeat cho tới khi chốt SLA agent-offline.** Mục D2 và D3 dưới
> đây vẫn độc lập và vẫn an toàn.

1. Gộp `heartbeat` vào `poll-commands` — `last_seen_at` đã được poll cập nhật
   ([poll-commands/route.ts:160](../../src/app/api/agent/poll-commands/route.ts#L160)).
   −86.400/agent.
2. `discovery` 60s → 300s. −34.560/agent.
3. `camera-probe`: chỉ báo khi kết quả đổi, sàn 60s. −43.200/agent.

Tổng −164.160/agent (−15%). **Nên làm bất kể chọn phương án nào** — không mất
chức năng, không đổi độ trễ. Nhưng một mình nó không cứu được bài toán scale.

## E. Realtime thay hẳn polling

Agent subscribe `agent_commands` qua Supabase Realtime; cloud INSERT → agent
nhận ngay.

- **Ưu**: bỏ 57% lưu lượng, độ trễ **tốt hơn** hiện tại (<1s vs 1,6s).
- **Nhược chí mạng**: WebSocket rớt là **mất lệnh**, không có ai đỡ. Kho mạng
  yếu — đúng môi trường của Betabox — là nơi kiểu lỗi này xảy ra nhiều nhất.
  Không nên chọn E trần.

## F. Realtime làm đường chính + poll 60s làm lưới an toàn ⭐

Chính là hướng anh đặt ra, và audit ủng hộ.

```
Realtime: lệnh tới trong <1s (đường chính)
Poll 60s: quét lệnh pending bị sót (đường đỡ)
```

Số request: poll 60s = 43.200/agent/tháng (so với 864.000 hiện tại), cộng
Realtime (WebSocket, **không** tính theo invocation).

10 kho: 15,2M → **≈2,9M**, tức **−81%**, mà độ trễ **tốt hơn** hiện tại.

**Vì sao F an toàn hơn E:** ba tầng đã có sẵn trong hệ, không phải xây mới:
- `agent_commands` có trạng thái pending/taken → lệnh sót vẫn nằm đó chờ
  ([poll-commands/route.ts:125](../../src/app/api/agent/poll-commands/route.ts#L125) gọi
  `reap_stale_agent_commands`).
- `claim_agent_commands` là RPC atomic → Realtime và poll cùng claim không
  sinh lệnh trùng.
- Hàng đợi phía agent đã chống mất dữ liệu khi đứt mạng.

**Về xác thực Realtime — ĐÃ SỬA ĐÁNH GIÁ.** Bản đầu coi "agent dùng HMAC,
không có JWT Supabase" là chướng ngại nặng. Đánh giá lại: **không phải blocker
kiến trúc.** Supabase Realtime Authorization dùng RLS trên `realtime.messages`
với JWT do ta tự ký — agent không cần thành Supabase user, không cần
service-role key. Cloud vốn là bên duy nhất giữ `warehouse_agents.secret` nên
đủ thẩm quyền cấp JWT ngắn hạn phạm vi hẹp.

Thiết kế chi tiết + threat model: xem AUDIT_CLOSURE Gate 4. Chi phí thêm của
đường cấp token: **2.880 request/agent/tháng** (1 lần / 15 phút).

## G. Agent gọi thẳng Supabase, bỏ Vercel khỏi đường agent

Tiền lệ đã có: `digest_daily/weekly/monthly` gửi Lark thành công **trong lúc
Vercel trả 402** (PRODUCTION_USAGE_RECONCILIATION §3.3) — pg_cron chạy hoàn
toàn trong Supabase.

- **Ưu**: bỏ gần hết lưu lượng Vercel phía agent.
- **Nhược**: toàn bộ authorization đang nằm ở route Vercel (HMAC v2 + nonce +
  tenant filter, 16 route). Chuyển sang Supabase nghĩa là **viết lại lớp bảo
  mật bằng RLS + RPC**. Cọc Gate 2 cross-tenant chưa verify tổng thể → rủi ro
  rất cao.
- Ứng viên hợp lý **từng phần**: `recording-files` (báo segment, 5,7% lưu
  lượng, dữ liệu append-only, không nhạy cảm) có thể đi RPC thẳng.

## H. Dashboard event-driven

Realtime cho `packing_events` thay poll 3s; giữ poll rất chậm làm nền.
10 kho: −3,3M request (−22%), và màn hình kho **nhạy hơn** hiện tại.

Độc lập hoàn toàn với A–G — làm được song song.

## I. Phương án audit phát hiện thêm: cắt nguồn theo camera

`recording-files` gửi **1 request mỗi segment 60 giây mỗi camera**
([segment-index.ts:327](../../warehouse-agent/src/segment-index.ts#L327)).

Ba cách giảm, chưa đánh giá đủ:
- Gom lô theo thời gian (ví dụ 5 phút/lần) thay vì gửi ngay → −80% nhóm này.
- Tăng độ dài segment 60s → 300s (đổi ở
  [active-credentials.ts:77](../../src/lib/camera/active-credentials.ts#L77)) →
  −80%, nhưng ảnh hưởng độ mịn khi cắt clip. **Phải kiểm tác động tới
  `cut_clip` trước.**
- Đẩy thẳng vào Supabase (xem G).

Chưa cấp bách ở 2 kho (5,7%), nhưng là trục tăng **theo camera** — kho 8–16
camera sẽ đổi hẳn tỷ trọng.

---

## Bất biến vận hành — ĐÃ CHỐT 10/08/2026

Chủ sản phẩm chốt. Không còn dòng `UNKNOWN` nào.

| Hành vi | CURRENT (đo/đọc được) | **REQUIRED (chốt)** | Nguồn |
|---|---|---|---|
| Bắt đầu ghi | p50 **1,61s**, p95 **3,06s** | **≤5s** (normal path) | truy vấn `agent_commands` |
| Dừng ghi | p95 **3,06s** | **≤5s** (normal path) | như trên |
| Lệnh cắt clip | p95 **2,77s** | **≤10s** (normal path) | như trên |
| Phát hiện camera offline | 30–60s (probe 30s × ngưỡng 2 nhịp fail) | **≤60s** | [camera-probe/route.ts:159](../../src/app/api/agent/camera-probe/route.ts#L159) |
| Camera coi là "chưa rõ" | 90s không có probe | giữ nguyên | [online-state.ts:18](../../src/lib/camera/online-state.ts#L18) |
| **Phát hiện agent offline** | **60s** | **≤60s — KHÔNG nới** | [live/summary.ts:7](../../src/lib/warehouse/live/summary.ts#L7) |
| Thu hồi camera bị tạm ngưng | ≤60s | **≤60s** | [index.ts:1677](../../warehouse-agent/src/index.ts#L1677) |
| Cắm máy quét mới được nhận | ≤60s | **≤5 phút** | [config.ts:37](../../warehouse-agent/src/config.ts#L37) |
| Độ tươi dashboard giám sát | 3s | **≤10s** | [operations/page.tsx:31](../../src/app/dashboard/operations/page.tsx#L31) |
| **Mất lệnh** | 0 — reaper kéo `taken` quá hạn về `pending` | **0 — không thương lượng** | [poll-commands/route.ts:125](../../src/app/api/agent/poll-commands/route.ts#L125) |
| **Lệnh trùng** | claim atomic qua RPC | **idempotent — không thương lượng** | [poll-commands/route.ts:143](../../src/app/api/agent/poll-commands/route.ts#L143) |
| Mất dữ liệu quét khi đứt mạng | 0 — JSONL append-only, đã chịu 47h thật | **0** | [queue.ts](../../warehouse-agent/src/queue.ts) |

### SLA hai tầng cho kiến trúc Realtime

| Tầng | Điều kiện | Yêu cầu |
|---|---|---|
| **Normal** | Realtime sống | đạt SLA lệnh ở bảng trên (≤5s / ≤10s) |
| **Degraded** | Realtime/WebSocket chết | fallback poll 60s; **cho phép** trễ tới ~60s |
| **Cả hai tầng** | mọi lúc | **tuyệt đối không mất lệnh** |

Đây là failure-mode SLA — **không** ép fallback phải đạt ≤5s. Thiết kế ở
AUDIT_CLOSURE Gate 4 đã đảm bảo điều này: Realtime chỉ đánh thức,
`agent_commands` + atomic claim vẫn authoritative, nên event mất chỉ làm
*chậm*, không làm *mất*.

### Quyết định bác bỏ, ghi lại để không bàn lại

Đề xuất nới **agent-offline 60s → 120s** để bỏ heartbeat: **BỊ BÁC.**

Lý do: audit đã chứng minh `last_seen_at` không chỉ để hiển thị — nó gate trực
tiếp Start/Stop/Status/Probe-codec/Test-connection (5 route, xem AUDIT_CLOSURE
Gate 3). Heartbeat còn là **đường duy nhất** mang `retention_days` xuống agent,
cộng `time_drift` và watchdog telemetry.

Đổi liveness độc lập + health telemetry lấy 86.400 request/agent/tháng là
không đáng — nhất là khi F đã loại phần lớn 864.000 lượt hỏi lệnh. Sau khi F
chạy ổn định ở production **có thể** xét giảm heartbeat 30s → 45s/60s, nhưng
không tối ưu nó ngay.

Đặc biệt: **`last_seen_at` không phải chỉ báo liveness đáng tin.** Route thoát
sớm ở bước tra `warehouse_agents` khi service key hỏng, nên cột này đứng im dù
agent vẫn đang gọi. Đã cắn thật ngày 10/08 và làm chẩn đoán sai hướng.

---

## Hướng đã chốt — chờ Gate 1 để ký triển khai

Kiến trúc chủ sản phẩm chọn sau audit, **F biến thể giữ heartbeat**:

```
Realtime private channel
        ↓  wake-up signal (KHÔNG mang nội dung lệnh)
poll-commands ngay lập tức
        ↓
atomic claim trong DB
        ↓
execute

Heartbeat 30s      ← GIỮ RIÊNG, độc lập
Fallback poll 60s  ← recovery path
```

### Phạm vi đã chốt

| Mục | Quyết định |
|---|---|
| D1 gộp heartbeat vào poll | ❌ **LOẠI** — xem phần bác bỏ ở bảng bất biến |
| D2 `discovery` 60s → 300s | ✅ trong phạm vi (SLA máy quét đã nới ≤5 phút) |
| D3 `camera-probe` báo theo thay đổi, sàn 60s | ✅ trong phạm vi (SLA camera offline giữ ≤60s) |
| F Realtime wake-up + queue authoritative | ✅ **hướng chính** |
| B/C adaptive backoff | ❌ không cần nữa nếu F chạy |
| `/watch` | ❌ **ngoài phạm vi tối ưu quota** — tách issue riêng |

### Còn đúng một chốt chặn: Gate 1

Chưa ký triển khai production của F tới khi có breakdown
invocation/duration theo route từ Vercel Observability. Có thể lật thứ tự ưu
tiên nếu `poll-commands` hoá ra rẻ về compute và một route khác mới đắt.

Ngoài ra nên đo lại `agent_commands` sau 30 ngày vận hành liên tục — 67 lệnh
hiện tại dính 47 giờ hệ chết và giai đoạn thử nghiệm.

### `/watch` — ba issue tách riêng, không thuộc đợt quota

1. Thiếu gate visibility (tab ẩn vẫn poll 2s).
2. **`preparing_cut` không có trần thời gian** → clip kẹt thì poll 2s vô hạn.
3. **Lỗi `ready` + `regeneration_error`**: không `stop()` cũng không
   `schedule()` → poll chết, và `pollTimerRef` còn giữ id timer đã bắn nên
   guard idempotent chặn luôn `start()`.

Mục 2 và 3 là lỗi **đúng đắn**, không phải lỗi tải.
