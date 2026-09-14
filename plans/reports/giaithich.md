# Betabox — Giải thích toàn bộ hệ thống

Tài liệu này giải thích **code đang làm gì** và **vì sao đoạn đó tồn tại**, đi từ
tổng quan xuống từng module. Phần camera (ghi hình + cắt clip bằng chứng) được
giải thích kỹ nhất vì đó là lõi nghiệp vụ và cũng là chỗ phức tạp nhất.

---

## 0. Hệ thống này làm gì

Betacom Beta Cam / Betabox là hệ **ghi hình đóng hàng tại kho + cắt video bằng
chứng theo mã vận đơn**, bán dưới dạng SaaS đa tenant.

Câu chuyện nghiệp vụ một vòng:

1. Nhân viên kho quét **QR nhân viên** → mở ca làm việc tại một bàn đóng hàng.
2. Nhân viên quét **mã vận đơn** trước camera → hệ tạo một `packing_event`.
3. Camera IP trong kho ghi hình **liên tục 24/7** thành các segment mp4 60 giây.
4. Khi có khiếu nại, người quản lý mở dashboard, tra mã vận đơn → hệ **cắt** đúng
   đoạn video quanh thời điểm đóng đơn đó và phát trong trình duyệt.

Hai layer chạy ở hai nơi khác nhau, và đó là ràng buộc kiến trúc quan trọng nhất:

|            | Cloud (Next.js 16)          | Warehouse Agent (Node → .exe) |
| ---------- | --------------------------- | ----------------------------- |
| Chạy ở     | VPS / Vercel                | Máy Windows trong kho khách   |
| Thấy gì    | Postgres, Storage, browser  | LAN kho, camera RTSP, ổ đĩa   |
| KHÔNG thấy | `192.168.x` của kho, ffmpeg | Không có gì ngoài kho         |

**Hệ quả xuyên suốt code:** cloud không bao giờ nói chuyện trực tiếp với camera.
Mọi việc đụng camera (test kết nối, quét LAN, probe codec, ghi hình, cắt clip)
đều đi qua **hàng đợi lệnh** `agent_commands`: cloud _enqueue_, agent _poll_ mỗi
3 giây, làm xong _callback_. Không có đường nào khác.

---

## 1. Bản đồ thư mục

```
src/
  proxy.ts                  ← "middleware" của Next 16: strip header, impersonation
  app/
    api/                    ← ~90 route handlers
      agent/                ← 13 endpoint CHỈ dành cho agent (xác thực HMAC)
      cameras/              ← CRUD + test + discover + recording start/stop/status
      order-proof/          ← clip bằng chứng: watch, retry, scans, filters
      warehouse/            ← scan ingest, discovery, heartbeat, live/*
      platform/             ← dành cho Betacom (chủ SaaS), không phải khách
      cron/, system/        ← job nền + tự kiểm hạ tầng
    dashboard/              ← UI cho khách thuê (tenant)
    platform/               ← UI cho chủ SaaS
  lib/
    camera/                 ← lõi camera phía cloud
    order-proof/            ← lõi cắt clip phía cloud
    watch/                  ← state machine xem clip + signed URL + cleanup
    warehouse/              ← HMAC agent, scan, staff QR, live/*
    agent-commands/enqueue  ← producer của hàng đợi lệnh
    system/                 ← 9 mục tự kiểm + cảnh báo Lark
    platform/               ← impersonation, audit, admin-check
    supabase/               ← client + guard phân quyền
warehouse-agent/src/        ← agent chạy trong kho
supabase/migrations/        ← 90+ migration, RLS + RPC
tests/, warehouse-agent/tests/
scripts/                    ← CI guard + tool vận hành
```

---

## 2. Nền tảng: xác thực, phân quyền, đa tenant

### 2.1 `src/proxy.ts` — cửa vào của mọi request

Next 16 đổi tên `middleware` thành `proxy`. File này chạy trước mọi request và
làm ba khối, đúng thứ tự:

**Khối 1 — strip tuyệt đối.** `stripInternalHeadersInPlace(request)` xoá sạch mọi
header `x-internal-*` do client gửi lên, **trước bất kỳ logic nào**. Nếu không có
bước này, kẻ tấn công chỉ cần tự đặt `x-internal-org-ctx` là đọc được dữ liệu tổ
chức khác.

**Khối 2 — impersonation của platform admin.** Khi nhân viên Betacom muốn xem
dashboard của một khách để hỗ trợ:

- Cookie `impersonate_org_id` (HttpOnly, JS không đọc được) chở org-id tới proxy.
- Proxy **vẫn** kiểm `checkPlatformAdmin(userId)` — cookie chỉ là phương tiện
  chở, không phải bằng chứng quyền.
- Nếu đúng platform admin → ký token HMAC `x-internal-org-ctx` (TTL 5 phút) rồi
  forward xuống route.
- Nếu **không** phải platform admin mà vẫn có cookie (giả/stale) → xoá cookie +
  redirect về chính URL đó. Không trả 403 chặn cụt: request thứ hai không còn
  cookie sẽ chạy như tenant bình thường.
- Nếu **không kết luận được** (service key sai, Supabase 5xx) → trả **503**, KHÔNG
  rơi xuống nhánh xoá cookie. Lý do ghi thẳng trong code: một platform admin thật
  đang làm việc mà bị xoá cookie vì lỗi hạ tầng nhất thời là phá phiên của họ.

Không rewrite URL (giữ `/dashboard/*` như tenant thường) để router client của
Next 16 không bị abort điều hướng.

**Khối 3 —** không impersonate thì chỉ refresh session Supabase như thường.

### 2.2 `src/lib/supabase/guard.ts` — ba lớp quyết định "anh là ai"

`readClaims()` là trái tim phân quyền, có đúng ba nhánh, cố ý viết phẳng để đọc
diff thấy ngay:

1. **Không có token** → tenant thường (99% traffic). Org lấy từ JWT claim
   `organization_id`.
2. **Có token nhưng không phải platform admin** → log cảnh báo, **bỏ token**, xử
   như tenant thường. Không trả lỗi riêng để tránh biến endpoint thành oracle.
3. **Có token + đúng platform admin** → verify chữ ký token, org lấy **từ token**
   (không phải từ JWT, không phải từ cookie), role gán `owner` ảo.

Ba hàm public:

- `requirePermission(perm)` — đọc role từ JWT (nhanh, chấp nhận token cũ vài phút).
- `requirePermissionStrict(perm)` — đọc lại role từ DB, kiểm `status='active'`,
  kiểm `organization_id` khớp. Dùng cho mọi thao tác ghi nhạy cảm.
- `requirePlatformRole(minRole)` — cho route `/api/platform/*`. Platform admin
  **không có** `organization_id` nên không dùng được hai hàm trên.

**Vế 4 — chống ghi nhầm khi mở 2 tab.** `checkRenderOrgMatch`: client wrapper
`apiFetch` chỉ gắn header `x-render-org-id` cho POST/PUT/DELETE (đọc từ
`data-render-org-id` mà layout nhúng server-side). Guard so header đó với org
sau khi verify token — lệch → **409 `org_context_changed`**, client tự reload.
Kịch bản đóng lại: tab A đang mở org X, tab B đổi cookie sang Y, tab A submit
form → không ghi nhầm vào Y.

### 2.3 Ba lớp cô lập tenant

| Lớp              | Ở đâu                                        | Chặn gì              |
| ---------------- | -------------------------------------------- | -------------------- |
| Route guard      | `requirePermission*`                         | Người không đủ quyền |
| Query filter     | `.eq("organization_id", ctx.organizationId)` | Đọc/ghi chéo tổ chức |
| RLS + RPC verify | `supabase/migrations/*_platform_aware.sql`   | Bug ở hai lớp trên   |

CI guard `scripts/check-tenant-scoped-writes.mjs` chặn merge nếu có route ghi mà
thiếu filter org.

---

## 3. Mô hình dữ liệu (bảng chính)

**Tổ chức & người dùng:** `organizations`, `user_profiles`, `role_permission_matrix`
(ma trận role × permission), `platform_admins`, `platform_audit_log`, `audit_logs`.

**Kho & bàn:** `warehouses` (chứa `packing_timing_config`, cấu hình Lark,
`retention_days`), `packing_stations`, `station_devices` (scanner **và** camera
soft-link), `station_device_assignments` (bàn ↔ thiết bị theo thời gian, có
`unassigned_at` để tra ngược quá khứ).

**Nhân sự:** `staff_profiles`, `staff_qr_credentials` (lưu `token_hash`, không lưu
token), `staff_work_sessions`, `staff_work_session_events`.

**Camera:** `cameras` (IP/port/path/user + mật khẩu **đã mã hoá** 3 cột
ciphertext/iv/tag + snapshot codec + kết quả probe), `camera_recording_sessions`
(một session = một ý định ghi), `camera_recording_files` (chỉ mục segment mp4).

**Quét & bằng chứng:** `warehouse_scan_raw_events` (bất biến, ghi thô mọi lần
quét), `packing_events` (đơn đã xử lý, có `work_started_at`/`work_ended_at`/
`timing_status`), `orders`, `order_proof_clips` (mỗi lần cắt = một row).

**Agent:** `warehouse_agents` (code, secret HMAC, `last_seen_at`,
`time_drift_seconds`), `agent_commands` (hàng đợi lệnh), `agent_log_events`,
`warehouse_agent_request_nonces` (chống replay), `system_jobs` (sổ cron),
`notification_logs` (chống spam Lark).

**RPC quan trọng** (logic nghiệp vụ đặt trong Postgres để chạy nguyên tử):

| RPC                                                      | Việc                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `process_waybill_scan`                                   | Quét mã → `packing_event`, đóng đơn trước đó, tính thời lượng  |
| `process_staff_qr_session`                               | QR nhân viên → mở/đóng/chuyển ca                               |
| `resolve_scanner_at` / `resolve_station_camera_at`       | Tra "lúc đó máy quét/camera này thuộc bàn nào"                 |
| `claim_agent_commands`                                   | Agent nhận lệnh, có `exclude_types` + `type_limits`            |
| `reap_stale_agent_commands`                              | Kéo lệnh `taken` quá hạn về `pending` (pg_cron mỗi phút)       |
| `enqueue_start_recording`                                | Tạo session + lệnh start trong 1 transaction, có advisory lock |
| `enqueue_clip_generation`                                | Tạo row clip `pending` + lệnh `cut_clip` trong 1 transaction   |
| `promote_clip_generation`                                | `pending → ready`, đồng thời `ready` cũ → `superseded`         |
| `apply_camera_probes_v2`                                 | Ghi kết quả probe hàng loạt, có lọc org trong chính RPC        |
| `close_stale_sessions`, `reap_orphan_recording_sessions` | Dọn ca/session treo                                            |

---

## 4. Luồng A — Quét mã và phiên làm việc

### A1. Máy quét → agent

`warehouse-agent/src/scanner.ts` mở cổng COM, gom byte vào buffer, flush khi gặp
CR/LF **hoặc** sau `FLUSH_DEBOUNCE_MS` (120ms) im lặng. Tự reconnect khi cổng
đóng. Máy quét bị rút và cắm lại sang COM khác thì `discovery.ts` (nhịp 60s) hỏi
cloud và **rebind** theo `device_identity` chứ không theo đường COM — đây là lý
do `DISCOVERY_INTERVAL_MS` để 60s chứ không 15s: cổng COM chỉ đổi khi có người
cắm dây, vài lần một tháng, mà nhịp 15s ngốn 172.800 request/tháng chỉ để nghe
lại đúng câu trả lời cũ.

Mỗi lần quét, agent sinh `agent_event_id` (UUID) rồi POST. Fail thì xếp vào
`data/pending-scans.jsonl` (`queue.ts`) và retry mỗi 5 giây — **quét không bao giờ
mất vì mạng**.

### A2. `POST /api/warehouse/scans` — cửa nhận quét

Đây là route đông nhất hệ thống. Trình tự:

1. Xác thực HMAC agent, lấy `organization_id` **từ danh tính agent**, không từ body.
2. `detectScanType()` — chuỗi khớp `<org_uuid>.<staff_uuid>.<token>` là **QR nhân
   viên**, còn lại là **mã vận đơn**.
3. `normalizeWaybillCode()` — trim, bỏ ký tự điều khiển, viết hoa. Nếu gặp ký tự
   lạ (`º § ∞ ¶ …`) thì **không tự sửa** mà gắn cảnh báo `suspicious_encoding`:
   đó là dấu hiệu máy quét sai layout bàn phím, sửa ngầm là giấu lỗi cấu hình.
4. `resolve_scanner_at` — tra máy quét thuộc bàn nào **tại thời điểm quét**. Không
   ghi kết quả vào row thô (raw event bất biến), chỉ trả cảnh báo cho agent.
5. `recognizeStaffQr` — tra bằng `token_hash`, **không tin `staff_id` trong QR**
   (staff_id chỉ là gợi ý tăng tốc; hash mới là bằng chứng).
6. INSERT `warehouse_scan_raw_events`. Trùng `agent_event_id` (agent retry) → bắt
   lỗi 23505, lấy row cũ, tiếp tục xử lý → **idempotent**.
7. Chạy RPC: QR → `process_staff_qr_session`; mã đơn → `process_waybill_scan`.
   Cả hai idempotent theo `raw_event_id`.
8. Lỗi nghiệp vụ (trùng đơn, chưa mở ca, máy quét chưa gán bàn, mã sai) → bắn Lark
   qua `after()` của Next 16. Dùng `after()` chứ không `void promise` vì trên
   serverless, promise trần bị giết khi lambda freeze sau response.

`POST /api/warehouse/manual-scan` là đường dự phòng: nhân viên gõ tay trên trang
`/dashboard/packing/scan` khi máy quét hỏng. Cùng RPC, cùng ràng buộc.

---

## 5. Luồng B — CAMERA (phần lõi)

### B1. Vòng đời camera trong cloud

**`src/lib/camera/crypto.ts` — mật khẩu camera.** AES-256-GCM, lưu 3 cột base64
(`ciphertext` / `iv` / `tag`). Khoá lấy từ `CAMERA_SECRET_KEY` (env) rồi
SHA-256 để luôn ra đúng 32 byte — người vận hành dán chuỗi bất kỳ cũng được.
**Rò DB thôi không lộ được mật khẩu camera** vì khoá không nằm trong DB.

**`src/lib/camera/rtsp.ts` — dựng URL.** Điểm tinh tế: mã xác minh của camera
EZVIZ thường chứa `#`, `@`, `:` — đúng những ký tự có nghĩa ngữ pháp trong URL
RTSP. Nên phần userinfo **phải** `encodeURIComponent`, còn path thì không. Có
nhánh riêng cho camera "chế độ tương thích cục bộ" chấp nhận RTSP ẩn danh: không
user, không pass thì phát URL **không có** phần userinfo, để ffmpeg không tự bịa
ra userinfo rỗng. `maskRtspUrl()` thay mật khẩu bằng `***` cho mọi đường log.

**`src/lib/camera/service.ts` — CRUD + cache.**

- `toPublicCamera()` là cửa duy nhất cho dữ liệu camera đi ra browser. Nó không
  bao giờ chép 3 cột mật khẩu, chỉ trả `has_password: boolean`.
- `ensureCameraSoftLinks()` tự tạo row `station_devices` cho mỗi camera, để trang
  "Thiết bị kho" và endpoint gán bàn làm việc đồng nhất cho camera lẫn máy quét
  mà UI không phải phân biệt hai bảng. Idempotent — hai request đua nhau thì cái
  thua ăn lỗi unique 23505 và **nuốt lỗi đó**, vì kết quả vẫn đúng ý muốn.
- Hai cache trong process, TTL 30 giây, khoá theo org. Comment ghi rõ vì sao TTL
  chấp nhận được: cache **chỉ** phục vụ UI `/dashboard/devices`; đường ingest quét
  và đường cắt clip dùng RPC `resolve_scanner_at` / `resolve_station_camera_at`
  đọc bảng sống, **không bao giờ** chạm cache này. Nên cache cũ chỉ làm UI cũ,
  không bao giờ gắn clip vào nhầm bàn.
- `updateCamera()` có ba trạng thái mật khẩu: `undefined` = giữ nguyên, `""` =
  xoá (set NULL cả 3 cột), chuỗi = mã hoá và thay.
- Tắt camera (`status != 'active'`) thì reset `probe_consecutive_fails = 0`. Lý do
  ghi trong code: agent chỉ probe camera đang trong ý định ghi, nên camera vừa tắt
  sẽ giữ nguyên số đếm mãi mãi — `hik_01` từng đứng ở **7452** suốt 8 ngày. Không
  gây sự cố, nhưng "số liệu chết thì sớm muộn có người đọc nó như số liệu sống".
- `deleteCamera()` chặn trước khi FK RESTRICT vỡ: nếu camera còn `order_proof_clips`
  thì ném `HasProofClipsError` — clip pháp lý gắn với **đơn hàng**, không được
  cascade theo camera. Người dùng phải chuyển camera sang `inactive` thay vì xoá.

**`src/lib/camera/codec-invalidation.ts` — HIGH-11.** Khi người dùng đổi bất kỳ
field kết nối (`ip`, `rtsp_port`, `rtsp_path`, `username`, `password`), snapshot
`codec_detected` cũ **không còn tin được** — URL có thể trỏ sang stream khác
(main ↔ sub, H.264 ↔ HEVC). Không vô hiệu hoá thì agent cắt HEVC trong khi DB nói
H.264 → codec guard fail hàng loạt cho tới khi có người probe tay. Nên: reset 4
cột codec **nguyên tử trong cùng câu UPDATE** với field kết nối, rồi enqueue
`probe_codec` mới (best-effort, fail thì chỉ để null, không rollback update).
Cố ý **không** so với giá trị cũ — probe thừa một lượt rẻ hơn nhiều một lần bỏ sót.

**`src/lib/camera/code-gen.ts` — sinh mã camera (client-side).** Người dùng gõ
"Vị trí" một lần ra cả Tên lẫn Mã. `slugifyVietnamese` chú ý thứ tự: NFD tách dấu
ra khỏi chữ, nhưng `đ`/`Đ` là code point riêng **không** tách được nên phải thay
thủ công, và cố ý viết **hai** lệnh replace vì `/đ/gi` không bắt được `Đ` một cách
đáng tin trong RegExp engine. Ràng buộc thật nằm ở unique index
`(organization_id, camera_code)` phía DB.

**`src/lib/camera/rtsp-presets.ts` — preset theo hãng.** Thuần client, chỉ sinh ra
chuỗi path. Có mặt vì topology phổ biến ở kho VN là **NVR**: camera con nằm trong
subnet riêng của NVR, người vận hành phải lấy RTSP theo _kênh_ từ IP của NVR chứ
không quét được camera. Hikvision `/Streaming/Channels/{ch}01` (ch không zero-pad,
`01` = main stream), Dahua/Imou `/cam/realmonitor?channel={ch}&subtype=0`.
`detectPreset()` là tra ngược để form sửa mở đúng hãng thay vì rơi về "Khác".

### B2. Tự tìm camera (discovery)

Logic nằm ở `src/lib/camera/discovery.ts`, và được **sao nguyên** sang
`warehouse-agent/src/lan-discovery.ts` (bỏ `import "server-only"`). Bản cloud giữ
lại cho triển khai on-prem và làm tài liệu tham chiếu; bản thật chạy ở agent, vì
Vercel POP APAC không thấy `192.168.x` của kho — trước 07/2026 route luôn trả 400
`no_private_subnet` chính vì lý do đó.

Ba tầng, rẻ trước đắt sau:

1. **ONVIF WS-Discovery** (`onvif.ts`) — multicast UDP `239.255.255.250:3702`.
   Tự cài đặt bằng `node:dgram` thay vì kéo npm package: giao thức nhỏ, và tránh
   được XXE từ payload do kẻ tấn công trong mạng điều khiển (dùng trích chuỗi
   khoan dung thay vì XML parser đầy đủ). Điểm mấu chốt: **phải gửi probe từ MỌI
   IPv4 interface**, không chỉ default route. Phần lớn báo cáo "không tìm thấy
   camera" đến từ chỗ này — camera ở Wi-Fi mà Node bind vào Ethernet.
2. **Quét cổng TCP** — chỉ RFC1918, prefix ≥ /24 (chặn cứng trong
   `validatePrivateCidr`), connect timeout ngắn, `runPool` giới hạn 64 luồng.
   Quick: `554, 80, 8080, 8000, 8899`. Full: thêm `5000, 37777` (Dahua NetSDK).
3. **Probe HTTP ẩn danh** (`probe.ts`) — chỉ ở chế độ full. HEAD
   `/onvif/device_service` (bất kỳ status < 500, kể cả 401, đều tính là "sống"),
   và đọc `Server` header + `<title>` để đoán hãng. **Không gửi credential.**
   Bộ đoán hãng cố ý bảo thủ: nhãn sai tệ hơn không nhãn.

`classifyDiscoveredDevice` xếp ba mức tin cậy: `onvif_camera` (ONVIF trả lời) >
`likely_camera` (mở cổng 554) > `needs_check` (chỉ có cổng web — có thể là router).

`rankCandidateSubnets` ưu tiên subnet đã có camera của org, rồi tới interface
thật, cuối cùng mới tới interface ảo (Docker/VMware/VPN/WSL — nhận diện theo tên
trong `isVirtualInterfaceName`). Có guard: nếu lọc ảo mà không còn subnet nào thì
quay lại danh sách gốc — thà quét thừa còn hơn chế độ full chết câm với 0 subnet.

**Route `/api/cameras/discover`:** `POST` enqueue lệnh `discover_lan` → trả
`command_id`; `GET?command_id=` để UI poll kết quả. Shape kết quả giữ y hệt bản
cũ để UI không phải đổi cách render.

### B3. Test kết nối camera — hai đường khác nhau

Đây là chỗ dễ nhầm, hai đường tồn tại song song có chủ đích:

| Đường  | Route                                    | Chạy ở đâu                | Khi nào dùng                     |
| ------ | ---------------------------------------- | ------------------------- | -------------------------------- |
| Nháp   | `POST /api/cameras/test-draft`           | **Cloud**, ffmpeg tại chỗ | Thêm camera mới, **chưa** lưu DB |
| Đã lưu | `POST /api/cameras/[id]/test-connection` | Enqueue → **agent**       | Camera đã có trong DB            |

`test-draft` nhận mật khẩu **plaintext** trong body, dùng để dựng URL RTSP trong
bộ nhớ, đưa thẳng cho ffmpeg rồi vứt: không ghi DB, không log, không echo lại
trong response. Mục đích: nếu test fail thì camera **không bao giờ** được ghi vào
DB, tránh để lại row rác chưa xác minh. (Đường này chỉ có nghĩa khi cloud cùng LAN
với camera; trên SaaS thật, luồng "Tự tìm camera" dùng agent.)

`test-connection` trả **202 + command_id** ngay, agent làm rồi callback vào nhánh
`test_camera_connection` của `/api/agent/command-result`, nhánh đó ghi
`cameras.last_test_result` + `last_tested_at`. UI poll cho tới khi thấy đổi.

**`src/lib/camera/ffmpeg.ts` — nơi duy nhất trong cloud chạm ffmpeg.** Tập trung
lại để credential không bao giờ lọt ra đường log nào khác. Vài chi tiết đắt giá:

- **Phải đọc stdout.** `stdio: ["ignore","pipe","pipe"]` và có listener rỗng cho
  stdout. Pipe buffer trên Windows chỉ ~4KB; stdout không ai đọc sẽ chặn `write()`
  của ffmpeg và treo cả tiến trình — hiện tượng này từng bị chẩn nhầm là "timeout
  mạng".
- **Không dùng `-stimeout` / `-rw_timeout` global.** Bản ffmpeg 8.1 (gyan.dev) từ
  chối với "Option not found". Timeout socket được uỷ cho việc kill tiến trình.
- Kill theo bậc: `SIGTERM` (cho ffmpeg kịp ghi mp4 trailer) → 1 giây sau `SIGKILL`
  → trên Windows thêm `taskkill /T /F` để diệt cả cây tiến trình con.
- `classifyFfmpegError()` dịch stderr thô thành câu tiếng Việt cho dashboard.
  **Không bao giờ** trả stderr thô ra client vì trong đó có URL RTSP kèm mật khẩu.
- `testConnection` chế độ `auto`: thử TCP trước (ổn định hơn qua NAT/Wi-Fi), fail
  thì thử UDP. Nhưng `isLikelyTransportIssue()` chặn retry khi lỗi là 401/404 —
  sai mật khẩu thì đổi transport cũng sai, chỉ tốn thêm 30 giây.

### B4. Probe codec và codec guard

Toàn hệ **chốt H.264**. Lý do: clip phải phát được thẳng trong `<video>` của
trình duyệt, mà pipeline cắt là copy-stream (không transcode) nên codec vào sao
thì ra vậy.

Ba chỗ kiểm codec, mỗi chỗ một mức nghiêm khắc khác nhau — đây là điểm cố ý:

1. **Trước khi spawn ghi hình** (`warehouse-agent/src/recording.ts::probeCodec`):
   ffprobe lấy `codec_name` của stream video đầu. **Chỉ cảnh báo**, không từ chối
   ghi. Ghi hình sai codec vẫn hơn không có hình. Kết quả báo lên cloud qua
   `recording-status` → `cameras.codec_detected` + `codec_warning='not_browser_safe'`.
   Probe là best-effort: fail thì `codec_detected = null` và **vẫn** spawn — "đừng
   để việc phụ (nhận diện) giết việc chính (ghi hình)".
2. **Theo yêu cầu** (`POST /api/cameras/[id]/probe-codec`) — enqueue lệnh, trả 202.
3. **Sau khi cắt clip** (`clip-cutter.ts::isBrowserSafeCodec`): **cứng**. Chỉ chấp
   nhận `codec_name = 'h264'` **hoặc** `codec_tag_string = 'avc1'` (hai field vì
   các bản ffprobe khác nhau ưu tiên field khác nhau). Không phải H.264 → clip
   `failed` với lý do rõ ràng. Cố ý **không** tự transcode: nêu lỗi để người vận
   hành điều tra, chứ không âm thầm ngốn CPU của máy đang ghi hình.

Giữa probe và spawn recording có `await sleep(50ms)` — nhiều camera giới hạn số
kết nối đồng thời (1–2), nên phải để OS dọn xong bắt tay TCP FIN trước khi mở
kết nối mới, không cho hai kết nối chồng nhau dù chỉ vài mili-giây.

### B5. Bật / tắt ghi hình

**`POST /api/cameras/[id]/recording/start`** không spawn gì cả — nó gọi RPC
`enqueue_start_recording` (B4 HIGH-12), RPC này trong **một transaction** với
advisory lock theo camera sẽ: kiểm session hiện có, kiểm lệnh `pending`/`taken`,
rồi tạo session + lệnh. Bốn phán quyết ánh xạ ra HTTP:

| Phán quyết                | HTTP | Nghĩa                                         |
| ------------------------- | ---- | --------------------------------------------- |
| `created`                 | 202  | Đã tạo session + lệnh                         |
| `already_recording`       | 200  | Đang ghi rồi — **idempotent, không phải lỗi** |
| `start_pending`           | 200  | Lệnh đã xếp hàng, trả lại `command_id` cũ     |
| `recording_state_unknown` | 409  | Có session treo không xác định được           |

Nhờ advisory lock + idempotent, double-click hay mở hai tab không đẻ ra hai session.

**`POST /api/cameras/[id]/recording/stop`** dùng `getOpenSessionForStop()` —
điều kiện là **`stopped_at IS NULL`**, chứ **không** phải `status='recording'`.
Đây là bài học đắt: bản cũ lọc cứng `status='recording'`, nên session rơi vào
`error` hay `connection_lost` thì không còn đường dừng qua sản phẩm — UI ẩn nút
(vì cloud tin là không ghi) và API trả 409, trong khi agent ở kho **vẫn** giữ ý
định ghi và spawn ffmpeg mỗi 5 phút. Đó là deadlock `hik_01` kho Đại Kim từ 24/07
đến 05/08, phải sửa DB bằng tay mới thoát. `stopped_at IS NULL` mới là định nghĩa
đúng của "còn mở": nó là thứ agent và cloud cùng đồng ý, không phụ thuộc lần báo
trạng thái cuối rơi vào nhánh nào.

Không còn gì để dừng → trả **200 `already_stopped`**, không phải 409. "Đã dừng
rồi" không phải lỗi, và trả lỗi biến nó thành ngõ cụt trên UI.

### B6. Agent ghi hình

**Desired state — `warehouse-agent/src/desired-store.ts`.** File JSON trên ổ trả
lời đúng một câu: _"khi agent khởi động lại, camera nào NÊN đang ghi"_. Chỉ chứa
`camera_id` + `session_id` + `desired_since`. **Tuyệt đối không chứa
`rtsp_url`/mật khẩu** — credential plaintext trên ổ máy khách là bước lùi so với
kiến trúc mã hoá bằng `CAMERA_SECRET_KEY`. Boot thì xin lại qua HTTPS + HMAC.
Ghi bằng atomic write (tmp + rename) để crash giữa chừng không để lại nửa file.

**Tham số ffmpeg** (`recording.ts::startRecording`):

```
-rtsp_transport tcp
-timeout 15000000        ← microseconds, option của RTSP demuxer, đặt TRƯỚC -i
-analyzeduration 5000000 -probesize 5000000
-i <rtsp_url>
-c:v copy                ← KHÔNG encode, chỉ remux → CPU gần như bằng 0
-bsf:v dump_extra        ← nhét SPS/PPS vào mỗi segment để cắt được độc lập
-an                      ← bỏ tiếng
-video_track_timescale 90000
-f segment -segment_time 60 -segment_format mp4
-reset_timestamps 1 -strftime 1
<root>/<code>/%Y/%m/%d/<code>_%Y%m%d_%H%M%S.mp4
```

`-timeout` bắt buộc phải có: thiếu nó, ffmpeg treo vô hạn khi host chết (không
route, IP giả), và watchdog không cứu được vì tiến trình vẫn "sống" trong lúc chờ
TCP timeout của OS.

**Watchdog khởi động (20 giây).** Spawn xong đợi 20s: ffmpeg chết trong khoảng đó
→ coi là _start failed_; sống qua được → báo thành công và từ đó mọi lần chết mới
gọi `onUnexpectedExit`. Con số 20 > `-timeout` 15 giây có chủ đích: nếu watchdog
ngắn hơn, ffmpeg đang stall connect sẽ bị coi là "sống", agent ghi desired và log
"start ok", rồi 15 giây sau rw_timeout kích và ffmpeg chết → vòng respawn.

**Chính sách retry** (`recording-lifecycle.ts`):

```
ffmpeg chết
   ├─ do watchdog tự kill?  → ÉP transient (xem dưới)
   └─ không → classifyErrorFromStderr(stderr)
         ├─ transient → short-retry 3 lần: 2s, 5s, 10s
         │     └─ cạn → long-retry 5 phút/lần, KHÔNG giới hạn số lần
         │           └─ ≥12 lần (~1 giờ) → báo cloud 'error_prolonged' (1 lần)
         └─ permanent → báo cloud 'error' + VẪN long-retry
```

Hai quyết định trong đó là bài học từ sự cố thật, và cả hai đều đi ngược trực
giác ban đầu:

_(a) `killedByWatchdog` phải là một cờ, không được đoán từ stderr._ Watchdog kill
là **hành động phục hồi của chính agent**, không phải bằng chứng camera hỏng.
Thiếu cờ này thì một cú kill lành bị đọc thành "camera hỏng vĩnh viễn". Ngày
29/07/2026 tại kho Đại Kim, `dahua_01` chết đúng kiểu đó trong khi `hik_01` dính
6 lần kill y hệt mà sống cả 6 — khác biệt chỉ là stderr.

_(b) KHÔNG BAO GIỜ xoá desired vì lỗi runtime, kể cả lỗi "permanent"._ `desired`
là **ý định ghi của người dùng**, không phải trạng thái sức khoẻ camera. Nó tồn
tại chính để agent tự dậy sau khi tắt máy cuối ca — mà tắt máy cuối ca là hành vi
bình thường của kho. 17:43 ngày 29/07, ffmpeg chết lúc tắt máy, stderr chỉ có
`Non-monotonic DTS; previous: 2691840420` — dãy số đó **chứa "404"**, bộ phân loại
cũ dùng `stderr.includes("404")` nên kết luận permanent → xoá desired → sáng hôm
sau bật máy, agent không còn biết phải ghi `dahua_01` nữa.

Hai hàng rào được dựng sau vụ đó, trong `recording.ts`:

- `PERMANENT_PATTERNS` neo vào **ngữ cảnh** chứ không vào số trần:
  `/\b401\b\s*unauthorized/i`, `/server\s+returned\s+40[14]\b/i`, … Mã trạng thái
  RTSP chỉ có nghĩa khi đứng cạnh chữ.
- `stripNoisyFfmpegLines()` lọc `Non-monotonic DTS` / `Timestamps are unset` /
  `Last message repeated` **trước khi** đưa vào tail 8KB dùng để phân loại. Hai
  tác dụng: tail giữ được dòng lỗi thật thay vì bị số DTS đẩy ra ngoài, và không
  còn số 9 chữ số để match nhầm. Log ra stdout vẫn giữ nguyên đầy đủ.

Chỉ **hai** đường được phép xoá desired: người dùng bấm Dừng ghi (`stopOne`), và
cloud không còn công nhận camera đó (`revokeDesired`).

**Watchdog runtime** (`ffmpeg-runtime-watchdog.ts`) đóng lỗ mà mọi tầng retry ở
trên đều không với tới: **ffmpeg treo mà không exit**. RTSP connect được (nên
không SIGPIPE) rồi stall — agent Running, session `recording`, heartbeat tươi,
dashboard hiện "Đang ghi", nhưng **0 byte mới ra ổ suốt cả ngày**. Cơ chế: mỗi 30
giây quét thư mục hôm nay của từng camera, tìm file segment **đã đóng** mới nhất;
nếu `now - mtime > 150s` (60×2 + đệm) thì **kill**, và chỉ kill — không tự spawn,
để retry layer vẫn là **đường spawn duy nhất**. Chỉ nhìn file `size > 0` vì
Windows không cập nhật mtime của file đang mở theo thời gian thực (đã xác minh
bằng 3 snapshot ngày 12/07/2026).

**Tắt máy êm.** `shutdown()` chờ tối đa **4500ms** — vừa khít trần Windows
(`WaitToKillServiceTimeout` 5000ms và nssm graceful 3×1500ms). Bản v0.7.0 dùng
`setTimeout(exit, 1500)`: agent chết sau 1,5 giây, ffmpeg con mất cha nên OS reap
ngay trong 0,01 giây, **không kịp nhận `q\n`** để ghi moov trailer → segment cuối
hỏng ("moov not found"). Nay `await` thật sự, và đóng segment trong DB **trước
khi** kill ffmpeg.

### B7. Chỉ mục segment — biết trên ổ có gì

Bốn mảnh, `segment-index.ts` là nhạc trưởng:

**`segment-watcher.ts`** — `fs.watch` cho phản hồi tức thì + poll dự phòng mỗi 10
giây (fs.watch bỏ sót event trên SMB/ảo hoá Windows). Chọn theo dõi **thư mục**
thay vì parse stderr ffmpeg: format log ffmpeg đổi theo version, còn filesystem
là sự thật vật lý, miễn nhiễm version. Khi bắt đầu theo dõi, "mồi" tập `seen`
bằng các file cũ để không phát event giả cho cả trăm file lịch sử — **trừ** file
mới nhất, vì đó chính là file ffmpeg đang cầm và tracker cần biết nó.

**`segment-tracker.ts`** — giữ "camera này đang ghi file nào". Điểm cốt lõi là
ngữ nghĩa timestamp:

- `started_at` = **parse từ tên file** (ffmpeg `-strftime` chốt tại lúc mở file),
  không phải "lúc watcher nhìn thấy". Watcher có thể chậm hàng chục giây (watchdog
  20s, agent restart giữa chừng, fs.watch chậm trên SMB) — dùng mốc quan sát thì
  bảng nói sai độ dài segment và bộ cắt clip báo lỗ hổng giả.
- `ended_at` của segment N = `started_at` của segment N+1. Segment đang mở có
  `ended_at = null`.

**`segment-report-queue.ts`** — mất mạng thì xếp vào `.jsonl`, flush mỗi 5 giây,
batch 50.

**Boot recovery** — agent chết/mất mạng lâu thì trên ổ có file mà cloud không
biết. Lúc khởi động: quét N ngày (`RECOVERY_SCAN_DAYS`, mặc định 30, suy từ
`retention_days` + đệm 5 ngày), hỏi cloud "anh đã biết những file nào", rồi bù
phần thiếu. Ba chi tiết đắt:

- Với file **không phải mới nhất**, `ended_at = min(mtime, started_at của file kế)`.
  Chỉ dùng `started_at` của file kế sẽ nói dối khi ffmpeg từng exit rồi spawn lại
  sau 14 phút: bảng sẽ ghi "segment này dài 14 phút" trong khi file chỉ có 30 giây
  video. `mtime` cho biết đúng lúc ffmpeg dừng ghi.
- File **mới nhất** mà `mtime` cách hiện tại < 20 giây thì **bỏ qua hẳn** — đó là
  file ffmpeg đang ghi, chốt `ended_at` bây giờ sẽ ghi sai độ dài (bug "17 giây").
  Tracker live sẽ đóng nó đúng cách khi ffmpeg xoay sang file kế.
- Row đã biết nhưng `ended_at = null` (mồ côi do tracker cũ chết giữa chừng) thì
  **vẫn** được cập nhật, không skip.

`POST /api/agent/recording-files` nhận batch (tối đa 200 file), upsert theo
`(organization_id, camera_id, file_path)`. Nếu đụng độ tên file mà row cũ **đã có**
`ended_at` thì **không cho ghi đè** (ghi đè = mất dữ liệu), chỉ log
`segment_collision` để người vận hành thấy — nếu cảnh báo này xuất hiện nhiều thì
phải thêm `%3N` (mili-giây) vào pattern ffmpeg.

### B8. Probe camera 30 giây và cơ chế thu hồi

`warehouse-agent/src/camera-probe.ts` cứ 30 giây lại **TCP connect** cổng RTSP của
mọi camera trong tầm, timeout 2 giây. Chọn TCP connect chứ không ffprobe: nhẹ
(~200ms, hợp với nhịp 30s), không đụng credential, và đủ chứng minh "IP này còn
nghe cổng RTSP" để chẩn đoán camera bật/tắt vật lý.

**Bắt buộc báo cả `ok=true` lẫn `ok=false`.** Chỉ báo khi ok thì camera vừa tắt
phải chờ hết 90 giây stale mới đổi trạng thái — chậm 90 giây. Báo cả fail thì
"Offline" hiện ở nhịp probe kế (tối đa 30 giây).

**Debounce đặt ở backend, không ở agent** (`/api/agent/camera-probe`): probe fail
lần đầu chỉ tăng `probe_consecutive_fails`, phải fail **2 nhịp liên tiếp** mới lật
`last_probe_ok = false`. Một nhịp ok ở giữa reset bộ đếm. Đặt ở DB vì agent
restart là mất state RAM; DB là nguồn chân lý sống.

**Piggy-back — gộp hai request thành một.** Trước đây mỗi nhịp 30 giây agent bắn
**hai** request: một lượt xin danh sách camera active, một lượt báo probe. Nay
body probe khai `want_active_cameras: true` và cloud trả kèm `active_cameras`
trong chính response đó: **172.800 → 86.400 request/tháng** cho mỗi agent chạy
24/7. Đổi lại, agent dùng danh sách của **nhịp trước** (trễ tối đa 30 giây). Gộp
theo chiều ngược lại thì kết quả probe về chậm 30 giây, làm đôi độ trễ phát hiện
camera offline — nên chọn chiều này.

**`syncDesiredWithActiveCameras` — luật quan trọng nhất của cả cơ chế.** Hàm thuần
`computeRevokedCameraIds(desiredIds, activeIds)` được tách riêng để test được, vì
sai một trong hai chiều đều nặng:

- `null` (request hỏng) mà thu hồi → kho mất mạng vài phút là xoá sạch desired;
  tắt máy cuối ca xong sáng mai không camera nào ghi lại.
- `[]` (cloud thật sự trả rỗng) mà **không** thu hồi → quay lại đúng bug `hik_01`:
  bấm "Tạm ngưng" trên dashboard rồi mà agent vẫn spawn ffmpeg mỗi 5 phút, và
  người dùng **không có đường nào dừng qua UI** vì cloud tin là camera không ghi.

Nên: **`null` = không biết gì, không đụng. Mảng = sự thật từ cloud, kể cả khi
rỗng.** Phía cloud, `listCameraCredentials` lọc `status='active'` cho **cả hai**
nhánh (theo danh sách id lẫn lấy tất cả) — "response thiếu camera = thu hồi ý định
ghi" là **hợp đồng** giữa hai bên.

**Fast recovery.** Long-retry là 5 phút/lần; camera chớp tắt 30 giây vẫn phải chờ
đủ 5 phút mới ghi lại — UX kho không chấp nhận được. Nên `notifyProbeResult()`:
nếu camera đang chờ long-retry mà probe OK **2 nhịp liên tiếp** thì huỷ timer và
spawn ngay. Đợi 2 nhịp (không phải 1) để chống dương tính giả khi mạng jitter.

### B9. "Camera online hay offline" — một nguồn chân lý

`src/lib/camera/online-state.ts` tồn tại vì một bug hiển thị: `/api/dashboard/overview`
đọc thẳng `cameras.status` ("active" = LIVE) trong khi `/api/devices` đã tính
trạng thái thời gian thực từ probe + heartbeat → **cùng một camera, dashboard nói
"LIVE" còn bảng thiết bị nói "Mất kết nối kho"**. Nay cả hai route gọi cùng
`deriveCameraOnlineState()`.

Ba cột heartbeat/probe, **đừng dùng lẫn**:

| Cột                                           | Ngưỡng | Trả lời câu                      |
| --------------------------------------------- | ------ | -------------------------------- |
| `warehouse_agents.last_seen_at`               | 60s    | Agent còn sống không?            |
| `camera_recording_sessions.last_heartbeat_at` | 90s    | Session này còn ghi không?       |
| `cameras.last_probe_at`                       | 90s    | Camera còn nghe cổng RTSP không? |

Bốn nhánh kết quả:

- probe tươi + ok → **online**
- probe tươi + fail → **offline** (agent ping được, camera không nghe)
- probe cũ + agent sống → **offline** (agent chạy mà không tới được camera)
- probe cũ + agent chết → **warehouse_disconnected** (không đổ lỗi cho camera)
- chưa từng probe → **not_probed**, _trừ khi_ đang có ý định ghi mà agent chết →
  **warehouse_disconnected** (hiện "Đã cấu hình" lúc đó là nói dối rằng mọi thứ ổn)

Có một cửa tin cậy phụ: nếu người dùng vừa bấm "Test kết nối" **thành công** trong
5 phút (`CAMERA_TEST_TRUST_MS`) thì coi là online bất kể probe. Chỉ tin test
**success**, không tin test fail — fail có thể là mạng chớp tắt, để probe/agent
chẩn tiếp. Lý do tồn tại: agent chỉ probe camera trong tầm ghi, nên camera vừa
cấu hình mà chưa bấm Start sẽ không có probe nào.

`src/lib/recording/ui-state.ts` là hàm thuần song song, cho **trạng thái ghi
hình**: `recording` / `agent_disconnected` / `stopped` / `error` / `unknown`.
Điểm mấu chốt: heartbeat cũ **không** nhảy sang `error` mà sang
`agent_disconnected` — agent hiccup mạng ngắn vẫn đang ghi vào ổ local; báo lỗi
lúc đó là nói dối. Tương tự `connection_lost` (reaper lật khi mất WAN > 15 phút)
cũng ánh xạ về `agent_disconnected`, và khi agent poll lại được thì
`/api/agent/poll-commands` **rescue** kéo session về `recording`, không cần người
can thiệp.

Bản thân route `/recording/status` được viết lại toàn bộ vì kiến trúc cũ giả định
ffmpeg chạy **trong** process Vercel: nó kiểm in-memory map, không thấy → lật
session sang `error` với thông báo "Recording process not found". Trên serverless
thì ffmpeg **không bao giờ** ở đó → mọi lần UI poll đều lật nhầm → "Lỗi ghi" giả
trong khi agent kho vẫn ghi thật.

### B10. Chống hai ffmpeg cùng ghi một camera

Ba tầng, dựng sau sự cố zombie:

1. **`pid-registry.ts`** — ghi PID ffmpeg xuống `data/ffmpeg-pids.json` ngay khi
   spawn, xoá khi exit. Boot sau đọc registry, `tasklist` kiểm PID còn sống thì
   kill. Có nhánh dự phòng `kill_by_registry_trust` cho trường hợp chạy dưới
   LocalSystem không đọc được CommandLine.
2. **`ffmpeg-marker-sweep.ts`** — quét mọi tiến trình ffmpeg có `recordingRoot`
   trong CommandLine mà **không** nằm trong registry → kill. Đóng ca registry
   hỏng/chưa kịp ghi khi crash cứng.
3. **Verify sau kill + `boot-declare`.** `verifyRegistryClean` dựa trên
   `isProcessAlive` (chỉ dùng PID, luôn đọc được). Nếu **còn** PID sống →
   **SKIP `lifecycle.boot()`**, ghi log CRITICAL, để người vận hành cứu tay. Cố ý
   không dựa vào lớp phòng thủ RPC ở cloud: chặn cứng tại đây.

`POST /api/agent/boot-declare` là mặt cloud của tầng 3: agent khai "những camera
này đang có ffmpeg chạy thật" (thường là `[]` sau khi kho tắt máy qua đêm), cloud
đóng mọi session `recording`/`connection_lost` **không** nằm trong danh sách đó.
Đây là quyền phá hàng loạt, nên `organization_id` **suy từ agent đã xác thực**,
không đọc từ body: kẻ có HMAC của agent A gửi org B trong body vẫn chỉ đóng được
session của org A.

Lưu ý còn mở, ghi rõ trong `recording.ts`: guard `runningMap + startupSet` chỉ
nguyên tử **trong một process Node**. Chạy hai agent cho cùng một kho thì mỗi
process có Map riêng. Hàng rào còn lại là partial unique index
`idx_one_active_recording_per_camera`, nhưng nó chỉ cứu được nếu cả hai đi qua
backend tạo session **trước khi** spawn ffmpeg. Đây là việc phải làm trước khi vận
hành nhiều hơn một agent.

---

## 6. Luồng C — Clip bằng chứng, từ đầu đến cuối

### C0. Sơ đồ tổng

```
Người dùng bấm "Xem" ở /dashboard/videos
        │
        ▼
POST /api/order-proof/{pe_id}/watch          ← state machine, poll 2s
        │
        ├─ đã có clip ready → cấp signed URL → PHÁT
        ├─ đơn còn 'open'   → order_open, poll chậm 5s, KHÔNG cắt
        ├─ agent offline    → warehouse_offline / offline_giveup
        └─ chưa có gì       → enqueueCutClip
                │
                ▼
        resolveClipBounds()   ← tính cửa sổ + chọn segment
                │
                ▼
        RPC enqueue_clip_generation   ← 1 tx: tạo row pending + lệnh cut_clip
                │
                ▼  (agent poll 3s)
        Agent: 8 bước cắt → upload → notify
                │
                ▼
        RPC promote_clip_generation   ← pending → ready, ready cũ → superseded
                │
                ▼
        Tick /watch kế → ready → signed URL → PHÁT
```

### C1. Cổng chặn: đơn chưa đóng thì không cắt

`src/lib/order-proof/proof-clip-gate.ts` là một hàm 20 dòng nhưng vá một lỗi
**toàn vẹn bằng chứng**, không phải lỗi hiển thị.

Đơn đang `open` chưa có `work_ended_at`, nên bộ giải cửa sổ rơi xuống nhánh dự
phòng và lấy `video_default_post_seconds` (mặc định 60 giây) làm biên cuối — một
con số phỏng đoán. Clip **70 giây** cho đơn `SPXVN066995638828` (kho Đại Kim) đã
được lưu làm bằng chứng chính thức, trong khi `packing_event` đó có
`work_duration_seconds = 180`.

Luật: `timing_status === 'open'` → chặn. `null`/`undefined`/`not_applicable` →
**cho phép** (row cũ trước khi có cột timing, và đơn trùng/chưa vào ca — chặn
chúng là mất khả năng xem clip của dữ liệu hợp lệ).

Cổng đặt **sau** nhánh ready (clip đã cắt xong vẫn xem được) và **trước** mọi
nhánh enqueue. Đơn đóng xong thì tick kế tự chuyển sang cắt với biên đúng, người
dùng không phải bấm gì.

### C2. Cửa sổ clip

`src/lib/order-proof/clip-window.ts` là hàm thuần, được dùng bởi **cả** bộ sinh
clip **và** bộ ước lượng dung lượng. Tách ra vì nếu mỗi nơi tự tính thì UI sẽ báo
một số còn agent render ra số khác, và cảnh báo "sắp vượt trần" thành vô nghĩa.

```
clip_start = scanned_at − video_pre_seconds
clip_end   = tuỳ timing_status:
      capped_timeout → scanned_at + work_duration_seconds + 5s
                       (KHÔNG dùng work_ended_at: đó là scan kế thật, quá xa)
      còn lại        → work_ended_at + 5s
rồi kẹp: tối thiểu 15s, tối đa 600s tính từ scanned_at
```

Đệm 5 giây sau `work_ended_at` để clip không cắt đúng khoảnh khắc quét mã đơn kế
— thao tác cuối của đơn trước thường còn dở dang. Sàn 15 giây vì đơn đóng cực
nhanh (3 giây) vẫn cần đủ hình để nhìn ra hành động.

**Hai lớp trần, đừng nhầm** (chốt 07/08/2026):

|                               | Con số | Ý nghĩa                                         |
| ----------------------------- | ------ | ----------------------------------------------- |
| `max_order_seconds`           | 180s   | **Nghiệp vụ** — đánh dấu ca đóng gói bất thường |
| `MAX_CLIP_DURATION_SECONDS`   | 600s   | **Kỹ thuật** — pipeline chịu được tới đâu       |
| `MAX_PROOF_CLIP_UPLOAD_BYTES` | 90 MiB | **Kỹ thuật** — trần upload Storage              |

Trần 600s hiện **không** phải chỗ chặn thật; chỗ chặn thật là 180s ở tầng nghiệp
vụ. Hồi trần upload là 50 MiB thì tầng dung lượng mới là chỗ chặn (camera
~256 KB/s → clip vượt ~195s là fail); từ 13/08/2026 nâng lên 100 MiB (guard 90)
thì tầng đó lùi lại phía sau.

### C3. Chọn segment — `clip-resolver.ts`

1. Tính cửa sổ (nhánh đơn đã đóng dùng `computeFinalizedClipWindow`; nhánh đơn
   chưa đóng có fallback next-scan → session-end → default-post).
2. `readTimingConfig()` kẹp cấu hình kho vào trần an toàn (pre ≤ 120s, before_next
   ≤ 60s, default_post ≤ 600s) và **log cảnh báo khi kẹp** — kẹp im lặng làm câu
   "sao cửa sổ 30 phút của tôi chỉ ra 10 phút?" thành không thể debug.
3. Xác định camera: ưu tiên `packing_events.proof_camera_id` (ảnh chụp lúc quét);
   không có thì gọi RPC `resolve_station_camera_at(station, scanned_at)` cho dữ
   liệu cũ.
4. Truy vấn `camera_recording_files` giao với cửa sổ, lọc **cả hai** mép ở tầng
   SQL để payload có biên kể cả camera có hàng tháng lịch sử, và lọc
   `source = 'agent'` — row do route Next.js cũ ghi trỏ tới ổ của máy khác, có thể
   không tồn tại trên ổ agent, tệ hơn là lẫn nội dung sai đơn.
5. Phân loại tình huống không cắt được, và **phân biệt nghiệp vụ với bug**: không
   có segment nào trong cửa sổ nhưng camera **có** row cũ hơn `retention_days` →
   `expired_retention` ("Video đã quá hạn lưu trữ"); không có row nào cả →
   `no_segments` (camera không ghi lúc đó — bug, cần điều tra). Nếu
   `retention_days` là NULL thì **không đoán**, giữ nhãn trung tính.

### C4. Segment "đang mở" vs "row mồ côi" — bug 92 đơn

`camera_recording_files.ended_at = NULL` mang **hai** nghĩa khác hẳn nhau, mà
resolver cũ gộp làm một:

- **(A)** Segment ffmpeg đang ghi ngay lúc này → đuôi video chưa flush, cắt bây
  giờ ra clip hỏng → phải chặn, bảo người dùng thử lại.
- **(B)** Row **mồ côi**: agent chết/mất điện giữa segment nên không kịp ghi
  `ended_at`. File trên ổ đã đóng từ lâu (hoặc đã bị dọn), không ai đóng row đó
  nữa. Chặn ở đây là **chặn vĩnh viễn**.

Ngày 04/09/2026, một row mồ côi từ 27/08 (`dahua_01_20260827_142531.mp4`) đầu độc
**toàn bộ** đơn của camera đó từ 27/08 tới 04/09 — **92 đơn, không đơn nào cắt
được clip**. Điều kiện cũ chỉ hỏi `started_at <= clipEnd`, mà một row từ 27/08 có
`started_at` nhỏ hơn **mọi** `clipEnd` sau đó. Bấm "Thử lại" vô ích vì row mồ côi
không bao giờ tự đóng.

`open-segment-verdict.ts` đặt luật mới: row open chỉ được coi là "đang ghi" khi
nó còn **trẻ** so với `clipEnd` — ngưỡng `OPEN_SEGMENT_MAX_AGE_SECONDS = 600`
(10× độ dài segment). Rộng rãi có chủ đích (chỗ cho lệch đồng hồ, ổ SMB lag,
ffmpeg treo chưa bị giết) nhưng chặt hơn "vô hạn" rất nhiều. Ngưỡng lệch về phía
**chặn**: trong vùng nghi ngờ vẫn chặn, vì clip hỏng tệ hơn bắt người dùng đợi
thêm một nhịp. Row bị xếp mồ côi được **log cảnh báo**, không im lặng bỏ qua —
im lặng thì lần sau lại mất 8 ngày mới phát hiện.

Vá tận gốc dữ liệu là cron `close-orphan-segments` (mục 8.3).

### C5. Enqueue — `enqueueCutClip`

Ngoài việc gọi resolver, hàm này còn:

- **Đệm GOP**: `cut_start = target_start − 3s`, `cut_end = target_end + 3s`. Vì
  `-c copy` snap về keyframe, không đệm thì mất vài giây đầu.
- **Phát hiện lỗ hổng**: hai segment liền kề cách nhau > 500ms là lỗ thật (camera
  offline, respawn chậm). Cộng thêm phần thiếu ở đầu/cuối cửa sổ → `is_partial`,
  `covered_range`, `total_gap_seconds`. Những số này **chỉ** hiện ở panel thông tin
  cạnh video, **không vẽ gì lên hình**.
- Gọi RPC `enqueue_clip_generation` — tạo row `order_proof_clips` trạng thái
  `pending` **và** lệnh `cut_clip` trong **một transaction**. Loại được race:
  "lệnh đã insert nhưng response mạng mất → xoá pending → lệnh mồ côi trỏ tới
  clip_id đã bị xoá". `clip_id` do RPC sinh rồi tự merge vào payload lệnh.

**Chốt kiến trúc 05/07/2026 — VIDEO THUẦN.** Không burn mã vào hình, không overlay
giao diện, không vẽ dấu lỗ hổng. Toàn bộ code burn/mark đã xoá và **không có kế
hoạch thêm lại**: mã đã có sẵn trong video gốc (nhân viên quét mã trước camera),
còn thông tin đơn thì hiện ở panel dashboard. Hệ quả kỹ thuật rất lớn: cắt clip
là copy-stream, vài giây cho clip 10 phút, gần như không tranh CPU với ghi hình.

### C6. Agent cắt clip — pipeline 8 bước

Trong `warehouse-agent/src/index.ts`, nhánh `command.type === "cut_clip"`. Ba
đường file: `{pe}.mp4` (canonical), `{pe}.{cmd}.tmp.mp4`, `{pe}.{cmd}.bak.mp4`.
**Fail ở bất kỳ bước nào từ 1–7 đều KHÔNG chạm canonical** — clip cũ còn nguyên.

| Bước | Việc                                                 | Fail thì sao                                                                                                                        |
| ---- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Kiểm segment còn trên ổ                              | So `started_at` với retention cache: cũ hơn → `clip_expired_retention` (nghiệp vụ); còn hạn → `segments_missing_on_disk` (bug thật) |
| 2    | Báo `encoding` để UI hiện tiến độ                    | Bỏ qua, không xếp outbox (tín hiệu tiến độ gửi muộn là vô nghĩa)                                                                    |
| 3    | `cutClip()` vào file **tmp**, bọc trong `encodeGate` | Báo failed kèm stderr tail                                                                                                          |
| 4    | Codec guard: chỉ `h264`/`avc1`                       | `unsupported_output_codec`                                                                                                          |
| 4b   | Size guard theo `stat()` **thật**                    | Trả kèm dung lượng/độ dài/bitrate để chẩn từ xa                                                                                     |
| 5    | Xin signed upload URL (backend tự tính path)         | `signed_url_fetch_failed`                                                                                                           |
| 6    | PUT lên bucket, có timeout theo dung lượng           | `upload_put_failed[kind]`                                                                                                           |
| 7    | Báo upload xong → backend verify + RPC promote       | Giữ object đã upload (TTL 72h tự dọn)                                                                                               |
| 8    | Đổi tên tmp → canonical, có rollback qua `.bak`      | Ghi marker `.stale`, boot sau tự phục hồi                                                                                           |

**Ghi chú `-ss` đặt SAU `-i`** — đây là ca đặc biệt của concat demuxer và là bẫy
kinh điển. Với file đơn có index, `-ss` trước `-i` là input seek, nhanh. Nhưng
concat demuxer **không hỗ trợ** input seek: nó tạo stream ảo nối các file, không
có index toàn cục. Đặt `-ss` trước `-i` với `-f concat` thì ffmpeg **bỏ qua** seek
— đã đo: clip ra **74 giây** thay vì 29 giây mục tiêu. Đặt sau `-i` thì ffmpeg
phải đọc timestamp mọi packet trước mốc (không decode, chỉ đọc container), tốn
~100–300ms với 2–3 segment — chấp nhận được.

**Encode gate 1-in-flight.** Một cờ boolean, không có hàng đợi local. Cơ chế đóng
kín ở cloud: agent poll với `encoding_busy=true` → cloud **loại** `cut_clip` khỏi
danh sách claim; rảnh → cloud claim tối đa **1** `cut_clip`. Lệnh dư nằm `pending`
ở cloud, lượt poll sau lấy. Gate ném `gate_busy_race` nếu bị gọi khi đang bận —
đó là **assertion phòng thủ fail-loud**: nếu poll-filter đúng thì không bao giờ
tới đó; nếu tới, ném lỗi rõ để lộ bug chứ không âm thầm chạy encode thứ hai.
Gate **chỉ** ôm bước 3, **không** ôm bước 6 — upload treo thì gate không bị giữ.

**Size guard** dựa trên `stat()` file thật, không suy từ thời lượng — bitrate
camera đổi là công thức theo thời lượng sai ngay. Số 90 MiB không phải đọc ô cấu
hình mà là **đo thật** bằng PUT tăng dần qua chính đường signed-upload-url:
100 MiB → 200 OK, 101 MiB → 413 `EntityTooLarge` (lặp lại bằng
`scripts/probe-storage-upload-limit.mjs`). Lịch sử đáng nhớ: hồi trần là 50 MiB,
guard từng để 49 MiB "cho an toàn" và **từ chối oan 87,6% clip chạy được** — vì
clip 190 giây thật nặng 49,3 MiB, sát mép. Lần này 90 MiB cách xa clip thật
(45–50 MiB) nên biên an toàn không loại bỏ gì.

**Upload có timeout** (`upload.ts`): `fetch(signedUrl, {method:"PUT"})` trần
không có timeout — Supabase POP treo (socket mở, không response) thì agent kẹt
**vô hạn** và pipeline clip tắc luôn. Nên timeout tỉ lệ dung lượng (base + 3s/MB,
kẹp 30s–5 phút), phân loại lỗi rõ: `timeout`/`network`/`http_5xx` → retry;
`http_4xx` → không retry (auth/policy sai thì thử lại vô nghĩa); `aborted` (do
shutdown) → dừng.

**Promote nguyên tử.** `clip-cut-result` với `outcome='done'` **không** chuyển
trạng thái sang `ready` — nó chỉ ghi metadata, status vẫn `pending`. Chỉ RPC
`promote_clip_generation` (gọi từ `clip-upload-complete`, sau khi backend đã HEAD
xác nhận object tồn tại) mới lật `pending → ready` **và đồng thời** `ready` cũ →
`superseded`. RPC idempotent nên callback bị phát lại vẫn an toàn.

**Bucket path v2** `{org}/{pe}/{clip_id}.mp4`: mỗi lần cắt có `clip_id` riêng nên
retry **không đè** object cũ — clip cũ còn nguyên trên bucket cho tới khi cron TTL
dọn sau 72 giờ. Path cũ `{org}/{pe}.mp4` vẫn chạy được vì mọi chỗ đọc `bucket_path`
**từ DB** chứ không tự dựng lại đường dẫn để tra cứu.

### C7. Signed URL — một cửa duy nhất

`src/lib/watch/proof-clip-signed-url.ts`. Bối cảnh: nhiều khách dùng chung một
project Supabase và chung bucket `proof-clips-transient`. RLS đóng được tầng row
(không thấy `pe_id` của org khác qua PostgREST), nhưng **Storage không có RLS
hiệu lực với `service_role`**. Nghĩa là route nào cầm `bucket_path` và gọi
`createSignedUrl` mà quên verify org là **lộ chéo tổ chức**.

Chiến thuật: cấm mọi caller gọi `createSignedUrl` trực tiếp. Chỉ helper này được
phép, và nó **tự** query DB verify org bên trong — caller **không** được truyền
`bucketPath` trần, chỉ truyền `pe_id` hoặc `clip_id`. Có CI guard
`scripts/check-proof-clip-signed-url.mjs` chạy ở `prebuild` để exit-1 nếu bắt gặp
`createSignedUrl` ngoài file này.

Kiểm trước khi ký: clip tồn tại, đúng org, `status='ready'`, `bucket_path` +
`bucket_uploaded_at` có, và còn trong TTL 72 giờ. URL cấp ra hạn **45 phút**.
Hai con số này độc lập, đừng lẫn: TTL bucket dài (xem lại không cần cắt lại), URL
ngắn (chống rò link).

### C8. `/watch` — state machine

Ba trụ được nêu ngay đầu file:

- **Trụ 1:** kiểm bucket **trước** kiểm agent. Clip đã có thì phát ngay, agent
  offline không liên quan.
- **Trụ 2:** đọc lại liveness agent **mỗi tick**, không cache.
- **Trụ 3:** "bỏ cuộc" đo theo **thời gian kho offline thật** (từ `last_seen_at`),
  không phải "tab này đã chờ bao lâu". Nên mở tab muộn khi kho đã offline 3 tiếng
  thì báo `offline_giveup` ngay, không bắt chờ thêm 10 phút.

Bảy trạng thái trả về: `ready` / `preparing_cut` / `failed` / `order_open` /
`warehouse_offline` / `offline_giveup`, cộng cờ `regenerating` khi có \*\*ready cũ

- pending mới song song\*\* (UI vẫn phát clip cũ, hiện huy hiệu "Đang tạo lại").

Vài nhánh đáng chú ý:

- **Cooldown 60 giây** (`hasRecentEnqueuedCut`): nếu vừa enqueue một `cut_clip`
  trong 60 giây qua **bất kể trạng thái nào** (pending/taken/done/failed) thì
  không enqueue nữa. Đây là hàng rào dựng sau khi rà DB thấy **32 lệnh `done` +
  0 row clip** cho một `pe_id` trong 10 phút: agent skip idempotent (không insert
  row) và điều kiện cũ chỉ kiểm pending/taken → vòng lặp "enqueue → skipped →
  không có row → enqueue". Đo theo `created_at` để lệnh đang `taken` cũng nằm
  trong cửa sổ.
- **`evicted`** (clip đã bị dọn khỏi bucket sau 72 giờ nhưng từng cắt thành công)
  → tự enqueue cắt lại từ video gốc, không bắt người dùng bấm gì. Nếu segment gốc
  **cũng** hết hạn thì thông báo phải nói đúng: "clip cũ đã dọn **và** video gốc
  cũng hết hạn", chứ không mô tả nhầm thành "cắt clip thất bại".
- **Insert row `failed` khi enqueue fail.** Nếu không insert, tick sau lại thấy
  "chưa có row" → enqueue lại → vòng lặp hoại. Và nếu chính lệnh insert đó bị từ
  chối (RLS, race unique) thì **vẫn** trả `failed` (kèm `[reconcile-write-failed]`)
  chứ **không** trả `preparing_cut` giả — trả `preparing_cut` là mở lại vòng lặp.

### C9. Ba lớp chống clip kẹt "Đang cắt" vĩnh viễn

Sự cố 11/08/2026, đơn `SPXVN068642901568`: agent cắt lỗi, callback
`/api/agent/clip-cut-result` trúng **deployment Vercel cũ đã disable** nên nhận
451 và không tới cloud, trong khi `/api/agent/command-result` lại tới. Kết quả:
`agent_commands.status='failed'` nhưng `order_proof_clips.status='pending'` — UI
hiện "Đang cắt" mãi mãi, không có cả nút Thử lại.

Ba lớp độc lập được dựng:

1. **Outbox ở agent** (`clip-result-outbox.ts`): callback không gửi được thì xếp
   xuống `data/pending-clip-results.jsonl`, drain lúc boot + mỗi 60 giây. Phân
   biệt lỗi cứng 4xx (bỏ, log ERROR — gửi lại cũng vậy) với 451/5xx/mạng (xếp
   hàng). Item quá 24 giờ thì bỏ kèm log.
2. **Cloud reconcile** ngay khi nhận `command-result` báo `failed` của `cut_clip`.
3. **`stale-pending.ts`** — quét theo tuổi, **không cần callback nào tới cả**.
   Điều kiện stale phải đủ **cả hai**: row `pending` già hơn 5 phút **VÀ** không
   còn `agent_commands` type `cut_clip` nào ở `pending`/`taken` cho đơn đó. Vế thứ
   hai là vế quan trọng: agent còn sống **không** chứng minh job cắt cụ thể còn
   chạy, nhưng lệnh còn `taken` thì **chứng minh được**. Nhờ vế đó, clip nặng cắt
   lâu không bao giờ bị đánh nhầm.

---

## 7. Kênh cloud ↔ agent

### 7.1 Xác thực HMAC

Hai phiên bản chạy song song trong cửa sổ rollout, chọn theo header
`x-agent-sig-version`:

**V1** (legacy): `HMAC(secret, "${timestamp}.${rawBody}")`, cửa sổ lệch đồng hồ
±5 phút. Không có nonce → **replay được**.

**V2**: canonical đa dòng

```
v2\n{agentCode}\n{METHOD}\n{canonicalPath}\n{sha256(body)}\n{timestamp}\n{nonce}
```

Ký cả **method** và **path** nên không thể lấy chữ ký của endpoint này dùng cho
endpoint khác. Nonce (16 byte base64url) được **consume nguyên tử** qua INSERT
vào `warehouse_agent_request_nonces` — trùng (23505) = replay = từ chối.

Ba chi tiết:

- Nonce chỉ consume **sau khi** chữ ký đã hợp lệ — không cho kẻ tấn công làm phình
  bảng nonce bằng request rác.
- Lỗi DB khác 23505 → **fail-closed**, coi như replay. Nonce store hỏng thì không
  cho request qua.
- `hmac_v2_enforced_at` bật **theo từng agent**: agent đã enforce mà gửi V1 → 401.
  Cho phép rollout dần từng kho.

`AGENT_API_PATHS` được **mirror** hai bên (`src/lib/warehouse/agent-api-paths.ts`
và `warehouse-agent/src/agent-api-paths.ts`), có test
`agent-api-paths-mirror.test.ts` chốt hai bảng khớp nhau — lệch một ký tự là
signature hỏng toàn bộ.

CI guard `scripts/check-agent-routes-use-verify-agent-request.mjs` chặn merge nếu
có route trong `api/agent/*` quên gọi `verifyAgentRequest`.

### 7.2 Hàng đợi lệnh

`agent_commands` với trạng thái `pending → taken → done|failed`.

- Agent poll `POST /api/agent/poll-commands` mỗi 3 giây, gửi kèm `agent_state`
  (danh sách recording đang sống, để cloud cập nhật `last_heartbeat_at`) và
  `encoding_busy`.
- `claim_agent_commands(agent_id, limit=20, exclude_types, type_limits)` nhận lệnh
  nguyên tử.
- **Reaper là pg_cron toàn hệ, chạy mỗi phút** — không còn piggy-back trên lượt
  poll như trước. Bản cũ chỉ dọn cho agent **đang** poll, nên agent chết im lặng
  thì lệnh `taken` của nó nằm lại vĩnh viễn. Bỏ lời gọi ở route cũng tiết kiệm
  1.959 round-trip ghi (đo bằng `pg_stat_statements`, đúng bằng số lượt claim).
  **Cảnh báo trong code:** ai tắt/xoá pg_cron job đó thì lệnh quá hạn sẽ không bao
  giờ được cứu, và **không có thông báo lỗi nào cả**.
- `command-result` chỉ đóng được lệnh đang `taken` **và** đúng agent đã xác thực.
  Nếu reaper đã kéo về `pending` trong lúc agent xử lý → **409 `stale_command`**,
  agent chỉ log rồi bỏ. Đây là bản chất **at-least-once**: mọi handler phải
  idempotent.

Danh sách loại lệnh: `start_recording`, `stop_recording`, `cut_clip`,
`probe_codec`, `test_camera_connection`, `snapshot_camera`, `test_camera_draft`,
`discover_lan`, `upload_clip`.

### 7.3 Heartbeat và đồng hồ

`POST /api/warehouse/heartbeat` mỗi 30 giây. Kèm theo:

- **Đo lệch đồng hồ**: agent gọi `GET /api/warehouse/time-check` (không HMAC — chỉ
  trả giờ, không lộ gì) **3 lần**, bù nửa RTT, lấy **MIN** (mẫu dính latency spike
  cho ra drift ảo cao). Lưu vào `warehouse_agents.time_drift_seconds`; > 30 giây
  thì dashboard hiện huy hiệu và agent log kèm sẵn lệnh `w32tm` để sửa. Đây là
  ràng buộc thật: mọi timestamp segment dựa vào đồng hồ máy kho, lệch giờ là cắt
  clip lệch.
- **Response trả `retention_days`** → agent cache xuống ổ, dùng cho script dọn
  segment và cho việc phân biệt `clip_expired_retention` với `segments_missing`.
  Cloud trả NULL (org chưa cấu hình) → agent **không** cache, để script dọn
  fail-loud thay vì đoán mặc định.

---

## 8. Vận hành, giám sát, job nền

### 8.1 Màn hình giám sát trực tiếp

`/dashboard/operations` gọi `GET /api/warehouse/live/overview`, gộp bốn phần:
`summary` (thẻ KPI + trạng thái agent), `stations` (thẻ bàn + ca đang mở + cảnh
báo idle 10 phút), `issues`, `activity` (nhật ký cuộn).

Bất biến quan trọng nhất của việc gộp: `resolveActivitySection()` hạ lỗi của riêng
phần nhật ký xuống **một field** (`activity_error`), **không** cho nó đánh hỏng cả
response. Hồi còn bốn endpoint rời, nhật ký hỏng chỉ hiện một dòng lỗi nhỏ dưới
bảng còn KPI vẫn vẽ; gộp mà không giữ ranh giới này thì một lỗi nhật ký sẽ thổi
bay cả màn hình giám sát — đúng lúc người ở kho cần nhìn nhất.

`startVisibilityPolling` (`src/lib/polling/visibility-poller.ts`) là hệ quả trực
tiếp của việc tháng 8/2026 tài khoản Vercel bị khoá vì vượt cả bốn hạn mức, phần
lớn lưu lượng là dashboard poll suốt ngày kể cả khi tab bị ẩn. Hai hành vi đi liền
nhau: tab ẩn → bỏ nhịp; tab hiện lại → gọi **ngay**, không bắt chờ hết chu kỳ.
Thiếu vế thứ hai là đổi tiết kiệm lấy dữ liệu cũ trước mắt người dùng.

### 8.2 Tự kiểm hạ tầng

`src/lib/system/checks.ts` — 9 mục, chạy mỗi 15 phút qua systemd timer gọi
`POST /api/system/check` (xác thực `CRON_SECRET`).

Ba ràng buộc cứng ghi ngay đầu file:

1. **Không throw.** Mục nào lỗi nguồn dữ liệu → `status: "unknown"` kèm giải
   thích. Một mục hỏng không được kéo chết các mục kia — "một hệ theo dõi trả 500
   là một hệ theo dõi cần người theo dõi nó".
2. **Không chạm đường agent.** Mọi truy vấn đều nhẹ, có timeout, và **chỉ đọc**.
3. **Không đoán số.** Chưa có nguồn dữ liệu thật thì trả `unknown` và nói thẳng,
   không bịa ngưỡng để ô hiện màu xanh cho đẹp.

Năm trạng thái: `ok` / `warn` / `crit` / `unknown` / `skipped`. `skipped` khác hẳn
`ok`: nó nghĩa là "kho không có hoạt động để đối chiếu, lần này không đánh giá".
Gộp ba trạng thái đó lại thì ô xanh lúc 3 giờ sáng sẽ nói dối — nó không chứng
minh gì cả. `skipped` **không bao giờ** sinh cảnh báo.

**Thay đổi lớn ngày 13/08/2026 — đồng hồ không phải là mốc, hoạt động nghiệp vụ
mới là.** Bản trước hỏi "bây giờ có phải giờ làm không" bằng khung giờ khai trong
`warehouses.operating_hours`. Hỏng ở hai chỗ: khung đó do người dựng hệ tự suy ra
chứ không ai ở kho xác nhận, và mọi kho mới đều phải nhớ khai — quên là bị bắn
cảnh báo mỗi đêm. Thay bằng câu hỏi **đo được**: _"kho có tiếp tục ĐÓNG GÓI sau
khi bằng chứng ngừng về không?"_. `packing_events` là nguồn **độc lập với agent**
(scan đến từ trình duyệt ở trạm, agent không ghi bảng này — grep 0 file). Nên:

- agent chết giữa ca → kho vẫn quét đơn → `lastScan` chạy tiếp, `lastSeen` đứng
  lại → hiệu số lớn dần → **báo**.
- kho đóng cửa bình thường → cả hai cùng dừng → hiệu số ≈ 0 → **im lặng**, không
  cần biết mấy giờ.

Và hiệu số đó không phải "im bao lâu" — nó là **lượng bằng chứng đã mất**, thứ duy
nhất đáng gọi người dậy. Không múi giờ, không DST, không khai báo.

`src/lib/system/alert.ts` gửi Lark với nguyên tắc **IM LẶNG LÀ BÌNH THƯỜNG**: tất
cả ok → không gửi gì. Ai nhận tin của bot này nghĩa là có việc phải làm — nếu bot
nói cả lúc khoẻ, người ta sẽ tắt thông báo và lần thật sẽ không ai đọc. Chống spam
6 giờ/mục, và **state chống spam lưu ở DB (`system_jobs`) chứ không ở RAM** — đây
là bài học đã trả giá: state RAM mất mỗi lần deploy, và chống-spam mất trí nhớ
nghĩa là mỗi lần restart lại nã một loạt tin. Webhook hạ tầng (`LARK_INFRA_WEBHOOK_URL`,
nhóm IT Betacom) **tách** khỏi webhook nghiệp vụ của kho: egress/disk là chuyện
nội bộ, khách không cần thấy.

`src/lib/system/status-view.ts` biến cùng dữ liệu đó thành trang
`/platform/system`. Tách file có chủ đích: `checks.ts` trả lời "hệ có sao không"
cho **con cảnh báo** (mỗi mục một dòng, gộp về mức nặng nhất, vì tin Lark chỉ có
chừng đó chỗ); `status-view.ts` trả lời câu khác cho **người**: "đang hỏng cái gì,
ở kho nào, tôi phải làm gì". File này **thuần suy diễn** — không truy vấn, không
`new Date()` ngầm, không dựng kết luận mới; nếu ở đây tính ra một kết luận mà tin
Lark không có thì trang và cảnh báo bắt đầu nói hai chuyện khác nhau.

### 8.3 Job nền

| Job                                   | Lịch           | Việc                                                                 |
| ------------------------------------- | -------------- | -------------------------------------------------------------------- |
| `GET /api/cron/cleanup-clips`         | systemd timer  | Xoá object bucket quá 72h, reset `bucket_path` → row thành `evicted` |
| `GET /api/cron/close-orphan-segments` | systemd timer  | Đóng row `ended_at IS NULL` quá cũ — **chỉ đóng, không xoá**         |
| `POST /api/system/check`              | 15 phút        | 9 mục kiểm + cảnh báo Lark                                           |
| `reap_stale_agent_commands`           | pg_cron 1 phút | Kéo lệnh `taken` quá hạn về `pending`                                |
| `cleanup_expired_agent_nonces`        | pg_cron        | Dọn nonce hết hạn                                                    |

Lịch nằm ở **systemd timer trên VPS**, KHÔNG ở `vercel.json` — VPS không đọc file
đó, và cron dọn clip từng **chết âm thầm 5 ngày** vì nhầm chỗ này. Mỗi lần chạy
ghi đúng một dòng `system_jobs` (kể cả khi lỗi hay ném ngoại lệ) để mục kiểm có
mốc "lần chạy gần nhất" mà đọc. Ghi sổ hỏng **không** làm hỏng việc dọn.

Đường bấm tay `/api/admin/cleanup-expired-clips` **cố ý không** ghi vào cùng
`job_name`: nó dọn trong phạm vi một org, và nếu ghi chung thì một cú bấm tay của
khách sẽ làm mốc "cron còn sống" tươi lại trong khi cron thật đã chết.

Xác thực bằng `verifyBearerSecret` (`src/lib/secure-compare.ts`) — so sánh
timing-safe. Và **chưa** ghi `system_jobs` khi secret sai: request không chứng
minh được là cron thật, ai gõ sai secret cũng làm mốc tươi lại được.

### 8.4 Đo phủ bằng chứng

`src/lib/system/evidence-coverage.ts` — file **thuần hàm**, trả lời hai câu bằng
**một** phép tính: "đơn này có mất bằng chứng không" và "kho mù bao nhiêu
bàn-phút". Cả hai đều là _hợp các khoảng đã ghi, trừ khỏi cửa sổ, đo phần còn lại_.

Cố ý **không** dùng lại kết luận của `resolveClipBounds`: resolver trả lời "có cắt
được clip không", nên **một** segment chạm mép cửa sổ là đủ `ok`. Một segment phủ
10 giây đầu của đơn 180 giây vẫn qua cửa đó — trong khi đơn ấy đã mất 170 giây
bằng chứng. Gộp hai câu hỏi lại là cách chắc chắn nhất để báo cáo hiện màu xanh
trong lúc khách đang xem clip cụt.

Nguyên tắc thứ hai: **đo kết quả, không đo nguyên nhân**. Không hàm nào ở đây đọc
heartbeat hay probe. Lý do: agent chết 10 phút trong lúc camera cũng offline đúng
10 phút đó phải ra **10**, không phải 20. Đo lỗ hổng trên trục "có/không có file"
thì hợp là hệ quả tự nhiên của phép tính, không phải một bước khử trùng lặp phải
nhớ làm đúng.

### 8.5 Ước lượng dung lượng clip trước khi cắt

`proof-size-estimate.ts` + `/api/warehouse/live/proof-size-risk`. Chỉ là
**visibility** — không cắt ngắn, không transcode, không đổi
`work_duration_seconds`. Vì không chặn gì nên ngưỡng cảnh báo đặt thấp hơn trần
upload mà không sợ chặn oan.

Thứ tự ước lượng đi từ chính xác tới phỏng đoán: (1) cửa sổ lấy từ **cùng** hàm
`computeFinalizedClipWindow` bộ sinh clip dùng; (2) có segment phủ cửa sổ → cộng
byte theo **phần chồng lấn thật** của chính các segment ấy; (3) thiếu metadata mới
rơi xuống bitrate p95 gần đây của đúng camera đó. **Không** cộng hệ số an toàn bịa
— pipeline là remux copy nên tổng byte segment sát byte clip; nếu sau này đo
production thấy overhead ổn định thì thêm hệ số **dựa trên số đo**.

---

## 9. Platform — dành cho chủ SaaS

`/platform/*` là khu vực của Betacom, tách hoàn toàn khỏi `/dashboard/*` của
khách. Menu riêng (`platform-nav.ts`), guard riêng (`requirePlatformRole`), hai
cấp quyền: `platform_support` < `platform_owner`.

- `/platform` — danh sách tổ chức, tạo tổ chức mới.
- `/platform/admins` — thêm/xoá quản trị nền tảng. Thêm là **gate cứng**
  `platform_owner`.
- `/platform/audit` — `platform_audit_log`, ghi mọi thao tác kèm **ảnh chụp bất
  biến** (`actor_email_snapshot`, `target_organization_name_snapshot`) để vẫn điều
  tra được sau khi FK bị SET NULL vì tổ chức bị xoá.
- `/platform/system` — trang tình trạng hạ tầng (mục 8.2). Chặn hai lần: menu
  tenant không có mục này, và API `/api/system/status` chặn lại bằng
  `requirePlatformRole`.
- Impersonation: `POST /api/platform/impersonate` đặt cookie; `DELETE` xoá.
  `ImpersonateWatcher` + `ImpersonateBanner` cho các tab khác biết cookie đã đổi
  và tự tải lại.

`admin-check.ts` phân biệt **ba** trạng thái chứ không phải hai: `platform` /
`not_platform` / `unavailable`. Đây là gốc của sự cố 10/08/2026: service key trên
Vercel bị từ chối (401), `supabase-js` **không throw** mà trả `{data: null, error}`,
code viết `const { data } = await ...` bỏ rơi `error` → mọi lượt kiểm trả về
"không phải platform" một cách im lặng → platform owner bị đẩy vào dashboard
tenant kèm banner "User chưa được gán organization" — đọc như tài khoản hỏng,
trong khi thứ hỏng là hạ tầng. Nay `unavailable` → **503**, không phải 403.

---

## 10. Frontend

- `src/app/dashboard/layout.tsx` + `DashboardLayout` — sidebar (`nav.ts`), navbar,
  banner impersonate, và nhúng `data-render-org-id` cho vế 4.
- `apiFetch` (`src/lib/api-fetch.tsx`) — wrapper fetch: tự gắn `x-render-org-id`
  cho request ghi, tự reload khi gặp 409 `org_context_changed`.
- `useWatchClipState` — state machine xem clip dùng chung. Trang chi tiết
  `/dashboard/orders/[pe_id]/watch` **đã xoá**; "nơi poll duy nhất" chuyển từ trang
  sang hook. Nhịp poll: 2s khi đang cắt, 5s khi đơn còn mở, 20s khi kho offline.
  Ghi rõ trong code: **đừng chép logic này đi nơi khác** — chép là sót nhánh
  (`offline_giveup`, dọn timer, reset bộ đếm khi retry) và sinh bug modal treo.

Các trang chính:

| Trang                                                            | Việc                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `/dashboard`                                                     | Tổng quan: KPI hôm nay, biểu đồ theo giờ, ảnh chụp camera            |
| `/dashboard/operations`                                          | Giám sát trực tiếp: thẻ bàn, KPI, nhật ký cuộn, sự cố                |
| `/dashboard/videos`                                              | Bằng chứng giao hàng — tra đơn, xem/tạo lại clip trong **một** modal |
| `/dashboard/devices`                                             | Camera + máy quét gộp một bảng (`CamerasView`)                       |
| `/dashboard/agents`                                              | Máy trạm kho: trạng thái, lệch đồng hồ, đặt lại secret               |
| `/dashboard/packing-stations`, `/staff`, `/users`, `/warehouses` | Quản trị                                                             |
| `/dashboard/settings/warehouse-config`                           | Cấu hình kho: timing clip, Lark, retention                           |
| `/dashboard/reports`                                             | Báo cáo hiệu suất theo ngày/nhân viên                                |
| `/dashboard/audit`                                               | Nhật ký thao tác                                                     |
| `/dashboard/packing/scan`                                        | Nhập mã thủ công khi máy quét hỏng                                   |

`/dashboard/videos` gom **mọi** nút hành động (Xem / Tạo clip / Thử lại / Tạo lại)
vào **cùng một** modal, khác nhau chỉ ở trạng thái ban đầu — người dùng không cần
nhớ nút nào mở gì.

---

## 11. Cấu hình (env)

**Cloud:**

| Biến                                                                                      | Việc                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`, `..._PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`            | Supabase                                                               |
| `CAMERA_SECRET_KEY`                                                                       | Khoá mã hoá mật khẩu camera — **mất khoá = mất toàn bộ mật khẩu**      |
| `PLATFORM_ORG_CTX_SECRET`                                                                 | Ký token impersonation, bắt buộc ≥ 32 ký tự (throw lúc boot nếu thiếu) |
| `CRON_SECRET`                                                                             | Xác thực cron + tự kiểm                                                |
| `BUCKET_TTL_HOURS` (72), `SIGNED_URL_TTL_SECONDS` (2700)                                  | Vòng đời clip / URL                                                    |
| `ENQUEUE_CUT_COOLDOWN_SECONDS` (60)                                                       | Chống đội lệnh cắt                                                     |
| `AGENT_OFFLINE_THRESHOLD_SECONDS` (30), `OFFLINE_POLL_GIVEUP_MINUTES` (10)                | Ngưỡng offline                                                         |
| `AGENT_ONLINE_STALE_MS` (60s), `CAMERA_PROBE_STALE_MS` (90s), `CAMERA_TEST_TRUST_MS` (5m) | Ngưỡng trạng thái camera                                               |
| `CAMERA_PROBE_FAIL_THRESHOLD` (2)                                                         | Debounce probe                                                         |
| `LARK_NOTIFY_ENABLED`, `LARK_INFRA_WEBHOOK_URL`                                           | Thông báo                                                              |

**Agent:**

| Biến                                        | Mặc định           | Việc                         |
| ------------------------------------------- | ------------------ | ---------------------------- |
| `BACKEND_URL`, `AGENT_CODE`, `AGENT_SECRET` | —                  | Danh tính + HMAC             |
| `RECORDING_DIR`                             | `./recordings`     | Gốc lưu segment              |
| `FFMPEG_PATH`, `FFPROBE_PATH`               | `ffmpeg`/`ffprobe` | Nhị phân                     |
| `POLL_INTERVAL_MS`                          | 3000               | Nhịp lấy lệnh                |
| `HEARTBEAT_INTERVAL_MS`                     | 30000              | Nhịp báo sống                |
| `CAMERA_PROBE_INTERVAL_MS`                  | 30000              | Nhịp probe camera            |
| `DISCOVERY_INTERVAL_MS`                     | 60000              | Nhịp đồng bộ máy quét        |
| `SEGMENT_WATCH_POLL_MS`                     | 10000              | Poll dự phòng cho `fs.watch` |
| `RECOVERY_SCAN_DAYS`                        | 30                 | Cửa sổ quét bù lúc boot      |
| `MAX_PROOF_CLIP_UPLOAD_BYTES`               | 90 MiB             | Trần upload clip             |

Layout thư mục ghi hình:

```
<RECORDING_DIR>/<camera_code>/<YYYY>/<MM>/<DD>/<code>_<YYYYMMDD>_<HHMMSS>.mp4
<RECORDING_DIR>/_clips/<packing_event_id>.mp4
```

Tiền tố `_clips` bắt đầu bằng gạch dưới có chủ đích: không bao giờ đụng độ với
`camera_code`, và script dọn segment **phải loại trừ** thư mục này — clip bằng
chứng có vòng đời khác segment.

---

## 12. Kiểm thử và CI guard

**Test app** (`node --test`, TS chạy thẳng qua `--experimental-strip-types`): 28
file, tập trung vào các hàm **thuần** đã tách khỏi I/O — chính là lý do những file
như `open-segment-verdict.ts`, `clip-window.ts`, `ui-state.ts`, `evidence-coverage.ts`,
`agent-auth-core.ts`, `platform/admin-check.ts` tồn tại riêng: mỗi file đó là một
bug đã xảy ra và giờ có test chốt.

**Test agent** (`tsx --test`): 9 file — outbox, atomic write, PID registry, size
guard, thu hồi desired, upload retry.

**CI guard** (script Node, chạy trong CI và ở `prebuild`):

| Script                                            | Chặn gì                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `check-proof-clip-signed-url.mjs`                 | Gọi `createSignedUrl` ngoài helper đã duyệt (chống lộ chéo tổ chức) |
| `check-tenant-scoped-writes.mjs`                  | Route ghi mà quên lọc `organization_id`                             |
| `check-agent-routes-use-verify-agent-request.mjs` | Route agent quên xác thực HMAC                                      |
| `check-migration-versions.mjs`                    | Hai migration trùng version                                         |
| `check-apply-camera-probes-legacy.mjs`            | Còn gọi RPC probe bản cũ (thiếu lọc tenant)                         |
| `check-audit-destruct-error.mjs`                  | Ghi audit mà bỏ rơi `.error` (mất bằng chứng âm thầm)               |

---

## 13. Những cạm bẫy đã trả giá — tra nhanh

| Triệu chứng                                                    | Gốc rễ                                                                                                | Nay chặn ở                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 92 đơn liên tiếp không cắt được clip, 8 ngày                   | Một row `ended_at=NULL` mồ côi từ 8 ngày trước chặn mọi cửa sổ sau nó                                 | `open-segment-verdict.ts` + cron `close-orphan-segments`                                               |
| Camera tạm ngưng vẫn bị ghi 78 lần/ngày, không tắt được qua UI | `listCameraCredentials` không lọc `status='active'`; `getActiveSession` lọc cứng `status='recording'` | `active-credentials.ts` + `getOpenSessionForStop`                                                      |
| Camera chết im cả ngày sau khi tắt máy cuối ca                 | Số DTS 9 chữ số chứa "404" → phân loại "permanent" → xoá desired                                      | `PERMANENT_PATTERNS` neo ngữ cảnh + `stripNoisyFfmpegLines` + không bao giờ xoá desired vì lỗi runtime |
| Clip 70s được lưu làm bằng chứng cho đơn 180s                  | Mở /watch lúc đơn còn `open` → resolver rơi nhánh `default_post` 60s                                  | `proof-clip-gate.ts`                                                                                   |
| Segment cuối hỏng "moov not found"                             | Shutdown 1,5s → ffmpeg mất cha → OS reap trước khi flush trailer                                      | `await` graceful 4500ms                                                                                |
| Dashboard "Đang ghi" nhưng 0 byte ra ổ cả ngày                 | ffmpeg treo mà không exit — mọi tầng retry chỉ kích khi _exit_                                        | `ffmpeg-runtime-watchdog.ts`                                                                           |
| Clip kẹt "Đang cắt" vĩnh viễn                                  | Callback trúng deployment cũ (451), lệnh thì `failed` còn clip vẫn `pending`                          | Outbox agent + reconcile + `stale-pending.ts`                                                          |
| 32 lệnh `done` + 0 row clip trong 10 phút                      | Agent skip idempotent, điều kiện cũ chỉ kiểm pending/taken                                            | Cooldown 60s ở `/watch`                                                                                |
| Platform owner thấy "User chưa được gán organization"          | Service key 401, `supabase-js` không throw, `error` bị bỏ rơi                                         | `admin-check.ts` ba trạng thái → 503                                                                   |
| Dashboard nói "LIVE", bảng thiết bị nói "Mất kết nối kho"      | Hai route tính trạng thái camera theo hai cách                                                        | `deriveCameraOnlineState()` dùng chung                                                                 |
| Cron dọn clip chết âm thầm 5 ngày                              | Lịch để ở `vercel.json` mà app chạy trên VPS                                                          | systemd timer + ghi sổ `system_jobs` + mục tự kiểm                                                     |
| Tài khoản Vercel bị khoá vì vượt cả 4 hạn mức                  | Dashboard poll cả khi tab ẩn; agent bắn 2 request mỗi nhịp probe                                      | `visibility-poller.ts` + piggy-back `active_cameras`                                                   |
| Guard 49 MiB từ chối oan 87,6% clip hợp lệ                     | Trừ biên an toàn khi clip thật đã sát mép trần                                                        | Đo trần thật bằng PUT tăng dần, guard 90/100 MiB                                                       |
| ffmpeg "timeout mạng" không lý do                              | Pipe stdout không ai đọc, buffer Windows ~4KB làm nghẽn `write()`                                     | Luôn gắn listener drain stdout                                                                         |
| Clip ra 74s thay vì 29s                                        | `-ss` đặt trước `-i` với concat demuxer → ffmpeg bỏ qua seek                                          | `-ss` đặt **sau** `-i`                                                                                 |
| Hai ffmpeg cùng ghi một camera sau kill -9                     | Guard chỉ nguyên tử trong một process                                                                 | pid-registry + marker sweep + verify + boot-declare                                                    |

---

## 14. Đọc tiếp

- `README.md` — cài đặt, chạy dev, migration, build agent.
- `warehouse-agent/CACH-CAI-KHACH.md` — hướng dẫn cài agent cho khách.
- `docs/remediation-2026-07.md` — trạng thái các finding bảo mật.
- `docs/audit-2026-08-10/` — kiểm toán dung lượng/request.
- `supabase/verify/` — script xác minh cho các migration lớn.

Và một lời khuyên rút ra từ chính codebase này: **các comment dài trong code
không phải rác** — gần như mỗi đoạn comment dài đều là một sự cố production có
ngày tháng cụ thể. Đọc comment trước khi sửa đoạn code nó bọc.

---

## 15. Phụ lục: Giải thích thuật ngữ chuyên ngành

Dưới đây là giải thích các thuật ngữ kỹ thuật xuất hiện trong tài liệu này, được chia theo từng nhóm để dễ tra cứu:

### 15.1 Kiến trúc & Hạ tầng tổng quan
- **SaaS đa tenant (Multi-tenant SaaS):** Phần mềm dạng dịch vụ phục vụ nhiều khách hàng (tenant) trên cùng một hệ thống. Mỗi khách hàng dùng chung cơ sở hạ tầng (Database, Server) nhưng dữ liệu được cô lập hoàn toàn.
- **Warehouse Agent / Agent kho:** Phần mềm nhỏ (chạy bằng Node.js đóng thành file `.exe`) cài trực tiếp trên máy tính tại kho của khách hàng. Nó làm cầu nối trung gian thực thi lệnh từ Cloud và giao tiếp với thiết bị mạng nội bộ (camera, máy quét) mà Cloud bên ngoài không thể nhìn thấy trực tiếp.
- **Proxy / Middleware:** Lớp mã chạy đầu tiên khi có yêu cầu gửi tới Cloud, dùng để kiểm tra quyền truy cập, strip (xoá) các thông tin giả mạo từ client, và điều hướng request.

### 15.2 Giao tiếp, Video & Camera
- **RTSP (Real Time Streaming Protocol):** Giao thức truyền phát video thời gian thực. Agent dùng giao thức này để kết nối và lấy luồng video trực tiếp từ các camera.
- **FFmpeg & FFprobe:** Các công cụ dòng lệnh xử lý đa phương tiện cực mạnh. FFmpeg ghi luồng RTSP thành các đoạn video nhỏ liên tục (segment mp4) và sau đó cắt/ghép clip bằng chứng. FFprobe dùng để kiểm tra thông số (probe) định dạng video của camera.
- **Codec (H.264 / HEVC):** Thuật toán nén video. Hệ thống chốt dùng chuẩn H.264 vì nó phát được trực tiếp trên thẻ `<video>` của trình duyệt Web mà không cần phải chuyển đổi (transcode), giúp tiết kiệm tài nguyên CPU.
- **NVR (Network Video Recorder):** Đầu ghi hình mạng. Hệ thống có các khuôn mẫu (preset) hỗ trợ tự động tìm cấu hình RTSP vì nhiều camera kho được nối qua đầu ghi NVR chứ không đi dây mạng độc lập.
- **ONVIF WS-Discovery / Multicast UDP:** Chuẩn giao thức cho phép hệ thống phát hiện tự động (discovery) các camera IP trong cùng mạng LAN bằng cách la lớn thông điệp Multicast để các camera tự trả lời.

### 15.3 Cơ sở dữ liệu & Độ tin cậy
- **RPC (Remote Procedure Call):** Các thủ tục lưu trữ (Stored Procedures) chạy thẳng bên trong DB Postgres. Giúp các thao tác nghiệp vụ chạy nguyên khối (nguyên tử) trong 1 giao dịch, chống sai lệch và "rách" dữ liệu.
- **RLS (Row Level Security):** Bảo mật cấp dòng của cơ sở dữ liệu Postgres. Nó đóng vai trò "chốt chặn cuối cùng" tự động chặn việc đọc/ghi chéo dữ liệu giữa các tổ chức (tenant) ngay cả khi tầng code bị lỗi quên filter.
- **Idempotent (Tính luỹ đẳng):** Khả năng thực hiện một hành động nhiều lần nhưng kết quả cuối cùng không đổi và không sinh lỗi (VD: máy quét mất mạng rồi gửi lại 1 mã quét 3 lần vẫn chỉ tính 1 lần đóng đơn).
- **Advisory lock:** Cơ chế khoá ảo ở cấp ứng dụng trong Postgres để tránh "Race condition" (đua lệnh). VD: chặn việc nhân viên bấm nút Ghi hình 2 lần liên tiếp đẻ ra 2 luồng ghi hình đụng nhau.

### 15.4 Xử lý tiến trình & Bảo mật
- **HMAC (Hash-based Message Authentication Code):** Cơ chế tạo chữ ký mã hoá xác thực. Cloud dùng để đảm bảo chỉ những Agent kho cầm đúng khoá bí mật mới được gửi dữ liệu hợp lệ lên máy chủ.
- **Impersonation:** Tính năng "nhập vai" mạo danh. Quản trị viên nền tảng có thể giả lập làm một khách hàng để vào trang dashboard của họ hỗ trợ lỗi mà không cần xin mật khẩu.
- **Watchdog / Watcher:** Luồng ngầm có nhiệm vụ giám sát. Nếu phát hiện FFmpeg bị treo hoặc chết, watchdog sẽ tự động ra lệnh khởi động lại hoặc sửa lỗi.
- **Zombie process:** Tiến trình FFmpeg bị kẹt, treo không thoát hẳn và không sinh ra file phim nào. Hệ thống có cơ chế đọc sổ đăng ký PID (`PID registry`) để lùng sục và ép huỷ (kill) các "thây ma" này.

---

## 16. Phụ lục: Tóm tắt luồng nghiệp vụ cốt lõi

Đây là tóm tắt nhanh về hai cơ chế hoạt động cốt lõi của toàn bộ hệ thống Betabox một cách đơn giản, ngắn gọn:

### 16.1 Tóm tắt Luồng ghi hình liên tục
1. **Thiết lập và Kết nối:** Người dùng định cấu hình camera trên Cloud. Yêu cầu (lệnh lệnh) được xếp vào hàng đợi. Warehouse Agent tải lệnh xuống và gửi request RTSP tới camera để bắt đầu thu luồng.
2. **Ghi hình chẻ nhỏ (Segmentation):** FFmpeg nhận luồng RTSP này (không tốn CPU encode lại, chỉ copy) và cắt tự động thành các đoạn video nhỏ độ dài 60 giây (segment mp4) lưu ngay trên ổ cứng máy khách ở kho.
3. **Quản lý Vòng đời (Watchdog & State):** Hệ thống có 1 cuốn sổ "Desired State" lưu ý định ghi. Nếu máy tính khởi động lại, sập nguồn, hay phần mềm bị lỗi tắt giữa chừng, Agent khi bật lên sẽ đọc sổ này, thấy danh sách camera cần ghi, và tự động gọi lại FFmpeg. Cùng lúc đó, các "Watchdog" sẽ quét liên tục để xử lý FFmpeg bị treo.

### 16.2 Tóm tắt Luồng cắt clip bằng chứng
1. **Xác định thời điểm:** Khi nhân viên thao tác quét mã vận đơn, sự kiện được ghi nhận lên cơ sở dữ liệu Cloud kèm một mốc thời gian bắt đầu và kết thúc (VD: Đóng đơn trong 25 giây).
2. **Tính toán cửa sổ cắt:** Quản lý bấm "Xem clip" cho đơn hàng đó. Cloud sẽ tính toán mốc thời gian (VD: lấy lùi 15s trước khi quét và thêm 15s sau khi quét), từ đó xác định chính xác cần lấy **những file video segment 60 giây nào** nằm trong khoảng thời gian đó.
3. **Cắt và Giao hàng:** Cloud thả lệnh "Cắt clip" xuống hàng đợi. Warehouse Agent dưới kho nhận lệnh, gọi FFmpeg nội bộ tiến hành lấy các file đã chọn, cắt chính xác tới mili-giây đoạn cần thiết, ghép chúng lại rồi đẩy kết quả (upload) lên bộ nhớ Cloud. Khi hoàn thành, UI trình duyệt của người dùng sẽ hiển thị trực tiếp clip vừa cắt.
