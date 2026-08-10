# AUDIT CLOSURE — Betabox, 10/08/2026

Phase 2, read-only. Đóng 4 gate trước khi quyết kiến trúc V2.

Trạng thái: **3/4 gate đóng. Gate 1 bị chặn ngoài tầm phiên này.**

---

## Gate 1 — VERCEL ROUTE RECONCILIATION · ⛔ BLOCKED

**Không truy cập được.** Vercel CLI trên máy chưa đăng nhập
(`Error: No existing credentials found`), và phiên này không chạy được OAuth.
Không có token API.

Đây là gate **duy nhất** cho phép nói về *chi phí*, nên mọi kết luận về chi phí
vẫn treo. Cần lấy thủ công:

Vercel → Project → **Observability** → Functions, lọc 24h và 7 ngày:

| Cần lấy | Vì sao |
|---|---|
| Invocations theo route | xác nhận `poll-commands` có đúng là nguồn lớn nhất |
| Duration p50/p95 theo route | route rẻ về số lượng có thể đắt về compute |
| Error rate theo route | retry ẩn |
| CPU/GB-hrs theo route (nếu có) | Fluid billing theo compute, không theo số lần |

Route cần soi: `/api/agent/poll-commands`, `/api/warehouse/heartbeat`,
`/api/agent/camera-probe`, `/api/warehouse/discovery`,
`/api/agent/recording-files`, `/api/warehouse/live/overview`,
`/api/order-proof/[peId]/watch`.

**Đính chính bắt buộc cho mọi tài liệu trước:**

> `poll-commands` chiếm **56,9% modeled HTTP request volume** ở kịch bản 10 kho.
> Tỷ trọng **Function Invocations / compute cost CHƯA XÁC NHẬN**.

Hai lần đo tỷ lệ request→invocation ra 2,09 và 1,14 — không được dùng hệ số
chung. Đã sửa trong CAPACITY_MODEL §1 và ARCHITECTURE_OPTIONS.

---

## Gate 2 — WATCH FLOW AUDIT · ✅ ĐÓNG

Endpoint: `POST /api/order-proof/{peId}/watch`
([use-watch-clip-state.ts:143](../../src/lib/watch/use-watch-clip-state.ts#L143)).

### Máy trạng thái poll

| State | Nhịp | Dừng? | file:line |
|---|---|---|---|
| `preparing_cut` | **2s** | không | [:219](../../src/lib/watch/use-watch-clip-state.ts#L219) |
| `ready` + `regenerating` | **2s** | không | [:162](../../src/lib/watch/use-watch-clip-state.ts#L162) |
| `order_open` | **5s** | không | [:210](../../src/lib/watch/use-watch-clip-state.ts#L210) |
| `warehouse_offline` | **20s** | không, tới khi giveup 10 phút | [:192](../../src/lib/watch/use-watch-clip-state.ts#L192) |
| lỗi mạng | 2s | không | [:230](../../src/lib/watch/use-watch-clip-state.ts#L230) |
| `ready` sạch | — | **DỪNG** | [:174](../../src/lib/watch/use-watch-clip-state.ts#L174) |
| `failed` | — | **DỪNG** | [:180](../../src/lib/watch/use-watch-clip-state.ts#L180) |
| `offline_giveup` | — | **DỪNG** | [:186](../../src/lib/watch/use-watch-clip-state.ts#L186) |

### Quả bom nhỏ hơn lo ngại

**Ba trạng thái kết thúc đều dừng poll.** Ca phổ biến nhất — khách mở xem một
clip đã cắt xong — tốn **đúng 1 request**, không phải 300.

| Kịch bản | Request |
|---|---|
| Clip đã sẵn sàng (phổ biến nhất) | **1** |
| Đang cắt, xong sau 60s | ~31 |
| Đơn còn mở 10 phút rồi cắt 60s | ~150 |
| Kho offline tới lúc giveup (10 phút) | ~30 |
| Tab để mở, clip ready | **1** (đã dừng) |

Con số "10 phút xem = 300 request" chỉ đúng nếu clip kẹt ở `preparing_cut`
suốt 10 phút — là ca sự cố, không phải ca thường.

### 100/1.000/10.000 lượt xem mỗi tháng

Giả định hỗn hợp 80% ready-ngay, 15% đang cắt, 5% đơn còn mở:

| Lượt xem/tháng | Request/tháng |
|---|---|
| 100 | ~1.400 |
| 1.000 | ~14.000 |
| 10.000 | ~140.000 |

Ở 10.000 lượt xem, `/watch` mới bằng ~1% mô hình 10 kho. **Không phải quả bom
như giả định** — nhưng vẫn là nguồn duy nhất tăng theo *người dùng cuối*, nên
phải theo dõi khi mở cho khách truy cập.

### Ba khiếm khuyết thật tìm được

**1. Không có gate visibility.** Không chỗ nào trong hook đọc
`document.visibilityState`. Tab ẩn vẫn poll 2s. Là khiếm khuyết duy nhất về
tải trong luồng này.

**2. Không có trần thời gian cho `preparing_cut`.** Nếu clip kẹt (agent chết
giữa chừng), tab poll 2s **vô hạn**. `warehouse_offline` có giveup 10 phút
([config.ts:82](../../src/lib/watch/config.ts#L82)) nhưng `preparing_cut` thì
không.

**3. Lỗi tiềm ẩn — `ready` + `regeneration_error` làm chết poll và khoá luôn
`start()`.** Ở [:174](../../src/lib/watch/use-watch-clip-state.ts#L174), khi có
`regeneration_error`: **không** gọi `stop()`, nhưng cũng **không**
`schedule()` — rồi `return`. Không có timer mới nên poll chết. Tệ hơn:
`pollTimerRef.current` vẫn giữ id của timer đã bắn, nên guard idempotent ở
[:236](../../src/lib/watch/use-watch-clip-state.ts#L236) (`if
(pollTimerRef.current) return`) chặn luôn `start()`. Ý định ghi trong comment
("GIỮ poll để user bấm retry lại") không đạt được.

Đây là **lỗi đúng đắn, không phải lỗi tải** — nó làm *giảm* request. Ghi lại để
xử lý riêng, không gộp vào đợt tối ưu.

### Phương án cho `/watch` (chưa làm)

| Cách | Giảm | Đánh đổi |
|---|---|---|
| Gate visibility | tuỳ hành vi người xem | không |
| Trần thời gian `preparing_cut` (ví dụ 5 phút → giveup) | chặn ca vô hạn | cần thông điệp UI |
| Backoff luỹ tiến 2s→5s→10s sau 30s đầu | ~50% ca đang cắt | thấy clip chậm hơn vài giây |
| Realtime (chung hạ tầng với F) | ~95% | phụ thuộc F |

---

## Gate 3 — COMMAND TRANSPORT vs AGENT LIVENESS · ✅ ĐÓNG

**Anh đúng, và đây là lỗi trong kết luận trước của tôi.** Tôi gọi heartbeat là
"thừa tuyệt đối" vì chỉ nhìn `last_seen_at` được ghi ở đâu, không nhìn nó được
**đọc** ở đâu.

### `last_seen_at` là phụ thuộc chức năng, không phải trang trí

Nó được đọc để quyết định **có cho phép ra lệnh hay không**:

| Route | file:line | Dùng để |
|---|---|---|
| Bắt đầu ghi | [recording/start/route.ts:58](../../src/app/api/cameras/[id]/recording/start/route.ts#L58) | chọn agent còn sống trước khi enqueue |
| Dừng ghi | [recording/stop/route.ts:84](../../src/app/api/cameras/[id]/recording/stop/route.ts#L84) | như trên |
| Trạng thái ghi | [recording/status/route.ts:92](../../src/app/api/cameras/[id]/recording/status/route.ts#L92) | phân biệt "agent chết" vs "camera lỗi", **ngưỡng 60s** |
| Probe codec | [probe-codec/route.ts:38](../../src/app/api/cameras/[id]/probe-codec/route.ts#L38) | như trên |
| Test kết nối camera | [test-connection/route.ts:48](../../src/app/api/cameras/[id]/test-connection/route.ts#L48) | như trên |
| Thẻ agent trên dashboard | [live/summary.ts:7](../../src/lib/warehouse/live/summary.ts#L7) | ngưỡng online **60s** |

### Hệ quả với phương án F

```
Hiện tại:  poll 3s  → last_seen_at tươi ≤3s   → 5 route trên luôn thấy agent sống
F + bỏ HB: poll 60s → last_seen_at tươi ≤60s  → chạm đúng ngưỡng 60s
```

Ngưỡng online là **đúng 60 giây** và nhịp fallback cũng **đúng 60 giây**. Hai
số bằng nhau nghĩa là hệ sẽ dao động qua lại ranh giới: người dùng bấm "Bắt đầu
ghi" đôi lúc bị từ chối vì cloud tưởng agent đã chết.

**Kết luận: KHÔNG được bỏ heartbeat cùng lúc với việc giãn poll.** Hai việc
này khoá lẫn nhau.

### Ba đường đi, chưa chọn

| Đường | Liveness | Ghi chú |
|---|---|---|
| Giữ heartbeat 30s, chỉ đổi command transport | ≤30s | An toàn nhất. Chi phí 86.400/agent/tháng — đổi lấy sự yên tâm |
| Bỏ heartbeat, poll fallback 20s | ≤20s | Fallback nhanh hơn thì mất ưu thế tiết kiệm của F |
| Bỏ heartbeat, nới ngưỡng online lên 120s | ≤60s | Rẻ nhất, nhưng **phải chốt SLA agent-offline trước** |

### Ba thứ khác chỉ heartbeat mang

| Trường | Ai cần | Mất nếu bỏ heartbeat |
|---|---|---|
| `retention_days` | agent cache → script dọn segment | **Đường DUY NHẤT** đẩy retention xuống agent. Bỏ là script dọn đọc cache cũ |
| `time_drift_seconds` | chẩn lệch giờ máy kho | mất tín hiệu chẩn đoán |
| `watchdog_last_tick_ms_ago` | cảnh báo watchdog chết ngầm | mất, mà nó vốn là lưới an toàn |

Ba trường này **không cần nhịp 30 giây** — nhưng cần *một* đường nào đó. Nếu
gộp vào poll thì poll không được chậm quá mức retention cache chấp nhận được.

---

## Gate 4 — REALTIME AUTH DESIGN SPIKE · ✅ ĐÓNG (thiết kế, không code)

Nguyên tắc anh đặt ra — **Realtime chỉ đánh thức, không mang lệnh** — là điểm
làm phương án này an toàn. Spike bám đúng nguyên tắc đó.

### Luồng

```
1. Agent  ──HMAC v2──────────────▶  POST /api/agent/realtime-token   (route MỚI)
2. Cloud: verify HMAC → sinh JWT ngắn hạn (TTL 15', claim: agent_id, org_id)
3. Agent  ──JWT──────────────────▶  Supabase Realtime, private channel
                                     topic: agent:{agent_id}
4. Cloud INSERT agent_commands   ──▶  Realtime phát "có việc" (KHÔNG kèm nội dung)
5. Agent nhận tín hiệu           ──▶  wake()
6. Agent  ──HMAC v2──────────────▶  POST /api/agent/poll-commands
7. claim_agent_commands()        ──▶  atomic claim, thực thi
8. Mất WebSocket?                ──▶  poll 60s vẫn quét pending như thường
```

Bước 6-7 **không đổi một dòng nào** so với hiện tại. Realtime chỉ thay thế
việc *hỏi dò*, không thay thế việc *lấy lệnh*.

### Vì sao không cần biến agent thành Supabase user

Supabase Realtime Authorization dùng RLS trên `realtime.messages` với JWT bất
kỳ do ta ký. Không cần email/password, không cần đưa service-role key xuống
agent. Cloud đã là bên duy nhất giữ `warehouse_agents.secret`, nên nó đủ thẩm
quyền cấp JWT phạm vi hẹp.

### Threat model

| Mối đe doạ | Đỡ bằng |
|---|---|
| **Trộm token** | TTL 15'; JWT chỉ cho *subscribe*, không đọc/ghi được `agent_commands`; muốn lấy lệnh vẫn phải có HMAC secret |
| **Replay** | Đường lấy lệnh vẫn là HMAC v2 có nonce + timestamp — không đổi |
| **Giả mạo agent** | Muốn xin token phải ký HMAC đúng ⇒ phải có secret |
| **Nghe lén org khác** | RLS trên `realtime.messages` so `agent_id` trong JWT với topic. **Phải test âm-tính**: agent A subscribe `agent:B` → từ chối |
| **Token hết hạn** | Agent tự xin lại trước hạn; hỏng thì rơi về poll 60s, không mất lệnh |
| **Rớt WebSocket** | Poll 60s là lưới; lệnh nằm nguyên ở DB |
| **Mất event** | Như trên — Realtime không authoritative nên mất event chỉ làm chậm, không mất lệnh |
| **Event trùng** | `claim_agent_commands` atomic; claim lần hai trả rỗng |
| **Đã claim nhưng agent chết** | `reap_stale_agent_commands` kéo `taken` quá hạn về `pending` ([poll-commands/route.ts:125](../../src/app/api/agent/poll-commands/route.ts#L125)) |
| **Thu hồi quyền một agent** | `warehouse_agents.status != 'active'` → route từ chối cấp token mới; tối đa 15' là mất quyền |

### Chi phí thật của F

Đường token thêm: 1 request/15 phút = **2.880/agent/tháng**. Không đáng kể so
với 864.000 đang bỏ đi.

### Việc phải kiểm trước khi ký F

1. Supabase Realtime trên gói hiện tại có giới hạn concurrent connection /
   message không → `NOT OBSERVABLE`, chưa mở trang usage Supabase.
2. Agent giữ WebSocket 24/7 qua NAT kho — cần đo tần suất reconnect thật.
3. Test âm-tính RLS cross-agent (bắt buộc, theo cọc Gate 2 cross-tenant).

---

## Bảng SLA — ĐÃ CHỐT 10/08/2026

> **Kết quả: chủ sản phẩm chọn bảo thủ hơn đề xuất của audit.** Bảng REQUIRED
> chính thức nằm ở ARCHITECTURE_OPTIONS §"Bất biến vận hành". Phần dưới giữ
> nguyên đề xuất ban đầu để đối chiếu.
>
> Khác biệt đáng ghi:
> - Start/Stop: chốt **≤5s** (audit đề xuất ≤10s)
> - Cắt clip: chốt **≤10s** (audit đề xuất ≤30s)
> - **Agent offline: giữ ≤60s — BÁC đề xuất nới lên 120s.** Kéo theo:
>   **không bỏ heartbeat**, giữ 30s độc lập.
>
> Thêm SLA hai tầng cho Realtime: normal path đạt bảng trên; degraded path
> (Realtime chết, fallback poll 60s) được phép trễ tới ~60s nhưng **không được
> mất lệnh**.

Cột "đề xuất" dưới đây là ý kiến audit, **không phải quyết định cuối**.

| Hành vi | Hiện tại | Đề xuất | Lý do |
|---|---|---|---|
| Bắt đầu ghi | p95 3,06s | **≤10s** | Thao tác cấu hình, không phải thao tác dây chuyền |
| Dừng ghi | p95 3,06s | **≤10s** | như trên |
| Lệnh cắt clip | p95 2,77s | **≤30s** | Người xem đằng nào cũng chờ cắt+upload lâu hơn thế nhiều |
| Phát hiện camera offline | 30–60s | **≤60s** | Giữ nguyên thực tế; siết hơn là tốn probe |
| **Phát hiện agent offline** | 60s | **≤120s** | Nới ra thì mới bỏ được heartbeat — xem Gate 3 |
| Thu hồi camera bị tạm ngưng | ≤60s | **≤60s** | Giữ; đây là đường chặn ghi nhầm |
| Độ tươi dashboard | 3s | **≤10s** | Người ở kho nhìn màn hình vài giây một lần, không nhìn liên tục |
| Nhận máy quét mới | ≤60s | **≤5 phút** | Người cắm dây đứng đó lâu hơn thế |
| Mất lệnh | 0 | **0** | Không thương lượng |
| Thực thi trùng | idempotent | **idempotent** | Không thương lượng |

Dòng đáng cân nhắc nhất là **agent offline ≤120s**: chốt 120s thì bỏ được
heartbeat và F đạt mức tiết kiệm tối đa; giữ 60s thì phải giữ heartbeat và F
tiết kiệm ít hơn khoảng 86.400/agent/tháng.

---

## Trạng thái 4 gate

| Gate | Trạng thái |
|---|---|
| Vercel route breakdown | ⛔ **BLOCKED** — cần lấy từ Observability |
| SLA REQUIRED | ✅ **ĐÓNG 10/08** — xem ARCHITECTURE_OPTIONS |
| `/watch` định lượng | ✅ đóng — nhỏ hơn lo ngại, 3 khiếm khuyết ghi nhận |
| Realtime auth | ✅ đóng — thiết kế + threat model xong |

**Còn đúng một chốt chặn: Gate 1.** Kiến trúc đã chọn (F giữ heartbeat) nằm ở
ARCHITECTURE_OPTIONS §"Hướng đã chốt". Chưa ký triển khai production tới khi có
breakdown invocation/duration theo route — nó có thể lật thứ tự ưu tiên nếu
`poll-commands` hoá ra rẻ về compute.

Tài liệu này là **snapshot audit**, không phải kết luận kiến trúc cuối. Khi có
số liệu Observability sẽ cập nhật bằng commit riêng, **không amend** commit
audit.
