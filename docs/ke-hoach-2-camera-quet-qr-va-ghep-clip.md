# Kế hoạch triển khai: 2 camera mỗi bàn — quét QR bằng camera + clip ghép chia màn hình

**Quy ước:**
- 🔵 **CÓ TRONG CODE** — kiểm được trong repo, có dẫn file.
- 🟡 **ƯỚC LƯỢNG** — suy luận, phải đo trên phần cứng thật trước khi cam kết.
- ⚠️ **PHẢI XÁC MINH** — chưa kiểm được từ repo (nằm trong schema gốc, phụ thuộc
  model camera, hoặc phiên bản thư viện).

---

## 0. Tóm tắt

### Yêu cầu

| # | Yêu cầu | Trạng thái hiện tại |
|---|---|---|
| R1 | Mỗi bàn có 2 camera: **camera toàn cảnh** + **camera quét QR** | 1 camera + 1 súng quét |
| R2 | Camera quét QR **thay thế súng quét** (đọc mã đơn, QR nhân viên) | Súng quét qua cổng COM |
| R3 | Mỗi camera ghi segment vào **thư mục riêng** trên ổ máy kho, 24/7 | Đã đúng như vậy |
| R4 | Chỉ khi có yêu cầu mới xử lý — **không làm sẵn** | Đã đúng như vậy |
| R5 | Khi có yêu cầu: cắt segment → **2 video** → ghép thành **1 video chia màn hình** | Chỉ cắt 1 góc |
| R6 | Video ghép có **đầy đủ thông tin** như panel dashboard hiện tại | Thông tin chỉ ở panel, không có trên hình |
| R7 | Đẩy video ghép lên Supabase | Đã có đường đẩy cho video 1 góc |

### Giả định

- **Cả 2 camera là camera IP PoE: Hikvision quay toàn cảnh, Dahua quét QR** (đã
  chốt — xem **mục 13**, mục này ghi đè các chỗ trong tài liệu giả định 2 camera
  cùng dòng). Không dùng webcam USB.
- **Quy trình vận hành đã chốt:** Dahua chỉ nhìn một **vùng quét riêng**, trong
  khung hình **chỉ có 1 mã QR tại một thời điểm**, xong đơn này mới đưa mã tiếp
  theo vào. Mục 13 mô tả cách biến quy trình này thành điều kiện hệ thống kiểm
  được.
- Nhãn vận đơn **có mã QR đọc được**. ⚠️ Nhãn SPX thường có cả barcode 1D Code128;
  thư viện đề xuất ở mục 4.3 đọc được cả hai, nhưng 1D khó đọc bằng camera hơn
  nhiều. **Phải cầm nhãn thật đo trước (mục 11, mốc M0).**

### Kết luận ngắn

| Phần | Độ khó | Vì sao |
|---|---|---|
| R3, R4, R7 | **Gần như có sẵn** | Kiến trúc hiện tại đã đúng mô hình này |
| R1 (ghi hình 2 camera) | **Thấp** | Camera thứ hai vào hệ như camera bình thường |
| R5, R6 (ghép + chữ) | **Trung bình** | Đường này đội cũ **đã từng chạy**, có số đo và bài học (mục 5.1) |
| **R2 (camera thay súng quét)** | **Trung bình** — hạ từ "Cao" nhờ vùng quét riêng + quy tắc 1 mã (mục 13) | Đọc nhầm một nhãn là **đóng sớm đơn đang đóng gói** và làm cụt bằng chứng (mục 4.1). Quy trình mới loại phần lớn nguyên nhân, nhưng vẫn phải có kiểm tra ở code vì quy trình có thể bị vi phạm lúc cao điểm |

🟡 Tổng thời gian: **6–9 tuần**, trong đó 2 tuần cuối là chạy thử song song với súng
quét. R2 là phần quyết định lịch, không phải R5.

---

## 1. Kiến trúc mục tiêu

```
                         ┌──────────────── MÁY KHO (warehouse agent) ────────────────┐
                         │                                                          │
 Camera TOÀN CẢNH ─RTSP──┼─► ffmpeg ghi hình (-c copy) ──► cam_wide/2026/09/13/*.mp4 │
   (luồng chính)         │                                                          │
                         │                                                          │
 Camera QUÉT QR ──RTSP───┼─► ffmpeg ghi hình (-c copy) ──► cam_qr/2026/09/13/*.mp4   │
   (luồng chính)         │                                                          │
                         │                                                          │
 Camera QUÉT QR ──RTSP───┼─► ffmpeg trích khung ─► bộ giải mã QR ─► lọc trùng ─┐    │
   (luồng phụ)           │     (5 khung/giây)       (zxing-wasm)    (máy trạng  │    │
                         │                                           thái)     │    │
                         │                                                     ▼    │
                         │                                   hàng đợi quét (có sẵn) │
                         └─────────────────────────────────────────────────────┬────┘
                                                                               │ HMAC
                                                                               ▼
                         ┌────────────────────────── CLOUD ──────────────────────────┐
                         │ /api/warehouse/scans ─► process_waybill_scan              │
                         │   → packing_event (chụp CẢ 2 camera tại thời điểm quét)   │
                         │                                                           │
                         │ Người dùng mở clip ─► /watch ─► resolveClipBounds         │
                         │   → cửa sổ thời gian + DANH SÁCH SEGMENT CHO TỪNG GÓC     │
                         │   → enqueue lệnh cut_clip (payload 2 góc + thông tin đơn) │
                         └────────────────────────────┬──────────────────────────────┘
                                                      │ agent poll 3 giây
                                                      ▼
                         ┌──────────────── MÁY KHO — khi có lệnh ────────────────────┐
                         │ A. Nối segment góc toàn cảnh  (-c copy, vài giây)         │
                         │ B. Nối segment góc quét QR     (-c copy, vài giây)        │
                         │ C. GHÉP chia màn hình + in chữ + mã hoá H.264  ◄── NẶNG   │
                         │ D. Kiểm codec, thời lượng, dung lượng                     │
                         │ E. Xin signed URL → PUT lên Supabase → báo cloud promote │
                         └───────────────────────────────────────────────────────────┘
```

**Nguyên tắc thiết kế xuyên suốt:**

1. **Ghi hình không bao giờ bị ảnh hưởng bởi thứ gì khác.** Giải mã QR và ghép clip
   chạy trong tiến trình riêng, dùng kết nối riêng, có mức ưu tiên CPU thấp hơn.
2. **Mọi thứ đắt chỉ làm khi có yêu cầu.** Giữ nguyên mô hình hiện tại.
3. **Thiếu một góc thì vẫn ra clip một góc, kèm cảnh báo trên hình** — không bao
   giờ bỏ cả clip vì thiếu một góc.
4. **Tái sử dụng tối đa đường đi đã được kiểm chứng** — hàng đợi quét, HMAC, outbox,
   signed URL, RPC promote.

---

## 2. Phần cứng và cấu hình hiện trường

Phần này quyết định thành bại của R2 nhiều hơn code.

### 2.1 Camera quét QR — tính khung hình trước khi mua

Bộ giải mã cần mỗi "ô vuông nhỏ" (module) của mã QR chiếm **tối thiểu 2–3 điểm
ảnh**, an toàn là 4. Công thức:

```
số điểm ảnh phủ mã QR = (chiều ngang ảnh giải mã) × (bề rộng mã QR) ÷ (bề rộng vùng camera nhìn thấy)
```

🟡 Ví dụ với mã QR rộng 3 cm, loại 33×33 module (cần ≥ 100–130 điểm ảnh):

| Ảnh dùng để giải mã | Vùng nhìn tối đa | Nhận xét |
|---|---|---|
| 1280 px (luồng phụ 720p) | **~30–38 cm** | Phải gá rất sát vùng quét |
| 1920 px (luồng chính 1080p) | ~44–57 cm | Thoải mái hơn, tốn CPU giải mã hơn |
| 2560 px (4MP) | ~60–75 cm | Tốt nhất, CPU giải mã cao nhất |

⚠️ **Đo mã QR thật trên nhãn SPX** (bề rộng và số module) trước khi chọn camera và
ống kính. Đây là con số đầu vào của mọi thứ khác.

**Hệ quả thiết kế:** camera quét QR **không phải camera nhìn cả mặt bàn**. Nó nhìn
một **vùng quét cố định nhỏ** mà nhân viên đưa nhãn vào. Điều này cũng là biện pháp
chống đọc nhầm quan trọng nhất (mục 4.1).

### 2.2 Cấu hình trên cả 2 camera (làm trong giao diện web của camera)

| Thiết lập | Giá trị đề xuất | Lý do |
|---|---|---|
| Codec | H.264 (hoặc H.265 — xem 3.3) | |
| **Khoảng keyframe (I-frame interval / GOP)** | **= số khung/giây** (keyframe mỗi 1 giây) | Cắt `-c copy` chỉ cắt được tại keyframe. GOP dài 4 giây nghĩa là sai số cắt và sai số căn 2 góc lên tới 4 giây |
| **Smart codec (H.264+ / H.265+ / Smart Codec)** | **TẮT** | Smart codec kéo dài GOP động theo cảnh tĩnh — phá độ chính xác cắt và căn góc |
| Tốc độ màn trập (camera QR) | **Cố định ≤ 1/500 s** | Mặc định camera tự hạ màn trập khi thiếu sáng → nhãn đang di chuyển bị nhoè, không đọc được |
| Khung hình/giây | 25 (giống nhau ở 2 camera) | Ghép 2 luồng khác fps phải chuẩn hoá, tốn thêm CPU |
| Luồng phụ (camera QR) | 1280×720 nếu model hỗ trợ | Dùng cho giải mã QR (mục 4.2) |
| Chữ thời gian in sẵn của camera (OSD) | **TẮT**, hoặc đồng bộ NTP | Nếu để, video bằng chứng có **hai đồng hồ** — của camera và của hệ thống — lệch nhau là tự mâu thuẫn |
| Số kết nối RTSP đồng thời | ⚠️ Kiểm model cho phép **≥ 2** | 🔵 `recording.ts` ghi nhận *"một số cam 1-2 max"*. Camera QR cần 2 kết nối cùng lúc |
| Đánh số kênh nếu qua NVR | `/Streaming/Channels/101`, `…/201` | 🔵 `rtsp-presets.ts` đã hỗ trợ theo kênh |

### 2.3 Ánh sáng và gá lắp

- Vùng quét cần đủ sáng đều, 🟡 ~300–500 lux, tránh đèn chiếu thẳng gây loá trên
  nhãn giấy bóng / màng bọc nilon.
- Camera QR gá **vuông góc** với mặt vùng quét, tránh góc xiên (mã QR bị méo phối
  cảnh làm giảm tỉ lệ đọc).
- Đánh dấu vùng quét trên mặt bàn (băng dính màu / khung) để nhân viên đưa nhãn vào
  đúng chỗ.

### 2.4 Hạ tầng mạng và điện

| Hạng mục | Yêu cầu |
|---|---|
| Switch PoE | 2 cổng/bàn, chuẩn 802.3af (🟡 camera IP thường 4–8 W/cái). Tính tổng công suất PoE của switch |
| Cáp | Cat5e/Cat6, ≤ 100 m mỗi đường |
| **UPS** | Cho **máy kho + switch PoE**. Mất điện đột ngột = segment cuối hỏng ("moov not found") + mất bằng chứng trong lúc mất điện |
| Đồng bộ giờ | NTP trên máy kho. 🔵 Hệ thống đã đo lệch giờ qua heartbeat (`time_drift_seconds`) |

---

## 3. Luồng 1 — Ghi hình 2 camera

### 3.1 Cái có sẵn, không phải viết

🔵 Mỗi camera là một dòng trong bảng `cameras`, mỗi camera một tiến trình ffmpeg,
mỗi camera một thư mục riêng:

```
<RECORDING_DIR>/<camera_code>/<YYYY>/<MM>/<DD>/<camera_code>_<YYYYMMDD>_<HHMMSS>.mp4
```

Nên **R3 ("2 folder riêng") đã được đáp ứng nguyên trạng**: đặt `camera_code` là
`ban01_wide` và `ban01_qr` là có 2 thư mục. Toàn bộ máy móc hiện có áp dụng cho cả
2 camera: thử lại khi ffmpeg chết, watchdog chống treo, lập chỉ mục segment, bù
chỉ mục khi khởi động, giết ffmpeg mồ côi, kiểm camera sống mỗi 30 giây.

### 3.2 Cái phải thêm: vai trò của từng camera

🔵 Hiện `station_devices.config_json` của camera có dạng `{ camera_id, role?: "proof_primary" }`
(`src/app/api/station-devices/route.ts`). Thêm vai trò:

| role | Ý nghĩa |
|---|---|
| `proof_primary` | Camera toàn cảnh — giữ nguyên tên để không phá dữ liệu cũ |
| `proof_qr` | Camera quét QR — **mới** |

Và bật cờ giải mã QR cho camera có role `proof_qr` (mục 4.2).

### 3.3 Hai thay đổi cấu hình ghi hình nên cân nhắc

**a) Cắt segment theo đồng hồ tường — `-segment_atclocktime 1`**

🔵 Hiện 2 tiến trình ffmpeg độc lập, mỗi cái bắt đầu segment tại một thời điểm
tuỳ lúc spawn. Thêm `-segment_atclocktime 1` khiến ffmpeg xoay file ở **đúng mốc
phút của đồng hồ** (14:03:00, 14:04:00…), nên segment của 2 camera **thẳng hàng
nhau**. Kết hợp GOP 1 giây (mục 2.2), sai số căn 2 góc giảm đáng kể (mục 5.5).

⚠️ Với `-c copy`, file vẫn chỉ xoay được tại keyframe đầu tiên sau mốc phút — nên
GOP ngắn là điều kiện đi kèm bắt buộc.

**b) Cho phép ghi H.265 để giảm một nửa dung lượng ổ**

🔵 Hiện hệ thống ép H.264 vì clip cắt `-c copy` phải phát được thẳng trên trình
duyệt (`clip-cutter.ts` — codec guard chỉ nhận `h264`/`avc1`).

Nhưng **khi clip nào cũng được mã hoá lại ở bước ghép (mục 5)**, video gửi lên luôn
là H.264 do mình sinh ra — **codec của bản ghi gốc không còn ràng buộc trình duyệt
nữa**. Nghĩa là camera có thể ghi H.265, 🟡 tiết kiệm khoảng 40–50% dung lượng.

Đánh đổi: giải mã H.265 ở bước ghép tốn CPU hơn — trừ khi dùng giải mã phần cứng
(Intel QuickSync từ thế hệ 6 trở lên giải mã được H.265). **Quyết định sau khi đo
mục 7.** Nếu bật, phải dời codec guard từ bước cắt sang bước kiểm file ghép.

### 3.4 Chụp camera tại thời điểm quét

🔵 RPC `process_waybill_scan` (migration `20260807100000_packing_timing_single_source_180.sql`)
ghi `packing_events.proof_camera_id` bằng `resolve_station_camera_at(...)` **tại
thời điểm quét** — để cắt lại một đơn cũ vẫn lấy đúng camera, kể cả khi sau đó
camera bị gán sang bàn khác.

Cần tương tự cho camera thứ hai:

- Migration thêm cột `packing_events.proof_qr_camera_id uuid null`.
- Hàm mới `resolve_station_camera_by_role_at(org, station, role, at)` (hoặc mở rộng
  hàm cũ nhận thêm `role`).
- Viết lại `process_waybill_scan` để ghi cả 2 cột.

⚠️ Hàm `resolve_station_camera_at` nằm trong schema gốc, không có trong thư mục
migrations — phải đọc định nghĩa thật trên DB trước khi sửa.

---

## 4. Luồng 2 — Camera quét QR thay súng quét

### 4.1 ⚠️ Rủi ro lớn nhất của cả kế hoạch — đọc trước

🔵 Trong `process_waybill_scan`, một lần quét được xếp `valid` (mã chưa quét trong
ngày + có ca đang mở) sẽ **mở cửa sổ thời gian cho đơn mới và đóng đơn đang mở tại
bàn đó**. Chỉ `valid` mới làm việc này; `duplicated` thì không.

Súng quét chỉ đọc khi nhân viên bóp cò. **Camera đọc mọi mã nằm trong khung hình.**
Nên:

| Tình huống ngoài đời | Camera làm gì | Hệ thống hiểu thành | Hậu quả |
|---|---|---|---|
| Kiện hàng **tiếp theo** đã dán nhãn nằm sẵn trong vùng nhìn | Đọc được mã mới | Quét `valid` | **Đóng sớm đơn đang đóng gói** → cửa sổ clip bị cắt ngắn → **bằng chứng bị cụt**, và sinh một đơn giả |
| Kiện vừa đóng xong còn nằm trong vùng nhìn | Đọc lại mã cũ | `duplicated` | Dòng dữ liệu rác + 🔵 **cảnh báo Lark "trùng đơn"** gửi cho khách (`hook-scan.ts`) |
| Nhân viên đeo **thẻ QR trên dây đeo cổ** trong vùng nhìn | Đọc QR nhân viên liên tục | Gọi `process_staff_qr_session` | ⚠️ Có thể **chấm ra ca / đổi người** ngoài ý muốn — route khai báo các hành động `checked_in \| checked_out \| switched_station \| replaced_staff \| ignored`; hàm RPC nằm ở schema gốc, **phải đọc để biết quét lại cùng bàn ra hành động gì** |

**Đây không phải lỗi hiển thị — đây là lỗi toàn vẹn bằng chứng**, đúng loại lỗi mà
cổng chặn `proof-clip-gate.ts` được dựng lên để ngăn.

**Sáu lớp chống đọc nhầm, dùng tất cả:**

1. **Khung hình hẹp** chỉ nhìn vùng quét (mục 2.1) — lớp mạnh nhất.
2. **Vùng quan tâm (ROI)**: chỉ giải mã phần giữa khung hình, cắt bằng filter
   `crop` của ffmpeg trước khi đưa vào bộ giải mã. Mã nằm ở mép ảnh bị bỏ qua.
3. **Kích thước tối thiểu**: bỏ mã có bề rộng < ngưỡng điểm ảnh — mã ở xa (kiện nằm
   dưới bàn, trên kệ phía sau) luôn nhỏ.
4. **Xác nhận qua nhiều khung**: chỉ chấp nhận khi cùng một mã xuất hiện ≥ K khung
   liên tiếp (🟡 K = 3 ở 5 khung/giây ≈ giữ yên 0,6 giây). Loại mã lướt qua.
5. **"Rời vùng rồi mới được đọc lại"**: sau khi đã phát một mã, mã đó bị chặn cho tới
   khi **vắng mặt liên tục ≥ N giây** (🟡 N = 3–5). Kiện nằm yên trong vùng nhìn
   không bao giờ bị phát lại.
6. **Luật riêng cho QR nhân viên**: chặn phát lại cùng một thẻ trong cửa sổ dài
   (🟡 10–30 phút), trừ khi thẻ rời vùng rồi quay lại **và** được giữ yên lâu hơn
   (🟡 ≥ 1,5 giây) — tức là một hành động chủ ý.

**Và một lớp an toàn bắt buộc khi triển khai: chế độ chạy bóng (mục 10.3)** — 2 tuần
camera đọc song song với súng quét, sự kiện camera **được ghi lại nhưng không tạo
đơn**, để đếm đọc nhầm trên dữ liệu thật trước khi bỏ súng.

### 4.2 Lấy khung hình từ camera — không được đụng vào tiến trình ghi hình

**Thiết kế đề xuất: một kết nối RTSP thứ hai tới luồng phụ của camera QR, tiến trình
ffmpeg riêng.**

```
ffmpeg -hide_banner -loglevel error
  -rtsp_transport tcp -timeout 15000000
  -fflags nobuffer -flags low_delay          ← giảm trễ, chỉ cho luồng giải mã
  -i rtsp://.../Streaming/Channels/102       ← luồng phụ
  -an
  -vf "fps=5,crop=<roi>,scale=<w>:-2,format=gray"
  -f rawvideo -pix_fmt gray
  pipe:1
```

Node đọc stdout theo từng khối cố định `w × h` byte = một khung ảnh xám.

**Vì sao KHÔNG dùng chung tiến trình với ghi hình** (ffmpeg làm được: một đầu vào,
hai đầu ra):

| | Tiến trình riêng (đề xuất) | Chung tiến trình |
|---|---|---|
| Số kết nối RTSP | 2 | 1 |
| Bộ giải mã treo/chậm | Chỉ mất quét QR | 🔵 **Chặn luôn ghi hình** — ffmpeg ghi pipe đầy thì dừng cả tiến trình, đúng bài học "phải đọc stdout" ghi trong `src/lib/camera/ffmpeg.ts` |
| Crash | Độc lập | Mất cả hai |
| Phân loại lỗi, thử lại | Tái dùng nguyên máy móc hiện có | Phải viết lại |

**Phương án dự phòng** nếu model camera chỉ cho 1 kết nối: chung tiến trình, nhưng
Node phải **đọc stdout liên tục và vứt khung thừa** khi bộ giải mã đang bận (không
bao giờ để pipe đầy). Chỉ dùng khi bắt buộc.

**Quy tắc đọc pipe (bắt buộc cho cả hai phương án):**

- Luôn đọc hết stdout, gom thành khung.
- Nếu khung trước chưa giải mã xong → **bỏ khung mới**, không xếp hàng. Chỉ giữ
  "khung mới nhất".
- Giải mã một khung một lúc.

**Trích khung chỉ 5 khung/giây** nhưng ffmpeg vẫn phải **giải mã toàn bộ luồng**
(H.264 khung sau phụ thuộc khung trước). 🟡 Luồng phụ 720p25 giải mã phần mềm tốn
khoảng 5–10% một nhân. Có thể thêm `-hwaccel qsv` hoặc `-hwaccel d3d11va` để giải
mã bằng GPU tích hợp.

### 4.3 Thư viện giải mã QR

Ràng buộc: agent được đóng gói thành một file `.exe` bằng `@yao-pkg/pkg`
(🔵 `warehouse-agent/package.json`). Module native (`.node`) phải khai báo tay
trong `pkg.assets` — dự án đã phải làm vậy với `serialport`.

| Thư viện | Loại | Đọc được | Tốc độ | Đóng gói vào .exe | Đánh giá |
|---|---|---|---|---|---|
| **`zxing-wasm`** | WebAssembly (bản dựng của ZXing-C++) | QR + **Code128 và các mã 1D** | 🟡 Nhanh | File `.wasm` đưa vào `pkg.assets`; Node đọc được từ snapshot của pkg | **Đề xuất chính** — đọc được cả 1D, giải quyết luôn ẩn số "nhãn là QR hay 1D" |
| `jsQR` | JavaScript thuần | Chỉ QR | 🟡 Chậm hơn | Không vấn đề gì | Dự phòng nếu WASM gặp trục trặc đóng gói |
| `@zxing/library` | TypeScript thuần | QR + 1D | 🟡 Chậm | Không vấn đề gì | Đang ở chế độ bảo trì, không đề xuất |
| `zbarimg.exe` (ZBar) | Chương trình ngoài | QR + 1D | Nhanh | Đóng kèm như 🔵 `vendor/nssm/nssm.exe` | Tốn một tiến trình mỗi khung — không hợp với 5 khung/giây |
| OpenCV WeChatQRCode | Native | Chỉ QR | Rất tốt với ảnh xấu | Rất nặng, đóng gói khó | Chỉ cân nhắc nếu tỉ lệ đọc của zxing không đạt |

⚠️ **Ghim phiên bản cụ thể** của `zxing-wasm` và kiểm lại tên hàm đọc ảnh tại thời
điểm triển khai — API giữa các phiên bản lớn có thay đổi. Kiểm tra được luôn: đưa
khung xám `w×h` vào, nhận về danh sách mã kèm **vị trí 4 góc** (cần cho lớp chống
nhầm "kích thước tối thiểu" và "ROI").

**Thử nghiệm tốc độ bắt buộc** ở mốc M2: 🟡 kỳ vọng 15–40 ms mỗi khung 1280×720 —
nếu vượt 150 ms thì 5 khung/giây không đạt, phải thu nhỏ ROI.

### 4.4 Máy trạng thái lọc trùng — module thuần, test được

Tách thành file thuần (không I/O), đúng phong cách của dự án
(🔵 `open-segment-verdict.ts`, `clip-window.ts`, `ui-state.ts`):

```
warehouse-agent/src/qr-debounce.ts

Đầu vào mỗi khung:  { frameAt: number, codes: [{ text, widthPx, center }] }
Đầu ra:             danh sách sự kiện cần phát (thường rỗng)

Trạng thái mỗi mã:
  firstSeenAt        lần đầu thấy trong chuỗi hiện tại
  consecutiveFrames  số khung liên tiếp thấy
  lastSeenAt         lần cuối thấy
  emitted            đã phát chưa
  armedAfter         thời điểm được phép phát lại

Luật:
  - bỏ mã có widthPx < MIN_WIDTH hoặc tâm nằm ngoài ROI
  - consecutiveFrames ≥ CONFIRM_FRAMES và chưa emitted
      và now ≥ armedAfter  → PHÁT, scanned_at = firstSeenAt
  - vắng ≥ ABSENT_REARM_MS  → reset chuỗi, cho phép phát lại
  - mã có dạng QR nhân viên → dùng cửa sổ chặn dài STAFF_SUPPRESS_MS
```

**`scanned_at` lấy thời điểm LẦN ĐẦU thấy mã**, không phải lúc xác nhận xong — nếu
không, mọi mốc quét trễ thêm `CONFIRM_FRAMES` khung một cách hệ thống.

🔵 Phân loại QR nhân viên dùng lại đúng regex của cloud:
`<org_uuid>.<staff_uuid>.<token ≥16 ký tự>` (`src/lib/warehouse/staff-qr.ts`). Agent
chỉ cần biết để chọn cửa sổ chặn; việc xác thực vẫn ở cloud.

### 4.5 Đưa sự kiện vào hệ thống — dùng lại đường có sẵn

🔵 Agent đã có hàng đợi quét (`queue.ts`, file `data/pending-scans.jsonl`), gửi lại
mỗi 5 giây khi mất mạng, và route `/api/warehouse/scans` idempotent theo
`agent_event_id`. Sự kiện từ camera đi **đúng đường này**:

```ts
{
  agent_event_id: randomUUID(),
  scanner_device_code: "ban01_qrscan",   // xem bên dưới
  raw_value: "<nội dung mã>",
  scanned_at: <firstSeenAt ISO>,
  source: "camera_qr",                    // mới
  port: null,
  device_identity_snapshot: { camera_id, decoder: "zxing-wasm@x.y.z", frames: 3, width_px: 142 }
}
```

**Cách không phải sửa RPC tra máy quét:** 🔵 `process_waybill_scan` xác định bàn
qua `resolve_scanner_at(org, scanner_device_code, scanned_at)`. Đăng ký thêm một
dòng `station_devices` loại `scanner` với `device_code = "ban01_qrscan"`, gán vào
bàn, và ghi `config_json = { source_camera_id }`. Khi đó **toàn bộ luồng xử lý quét,
phiên làm việc, đơn hàng chạy nguyên trạng**.

Thay đổi cần làm ở cloud:

- 🔵 `src/app/api/warehouse/scans/route.ts`: thêm `"camera_qr"` vào `ScanSource` và
  `parsePayload`.
- ⚠️ Kiểm constraint cột `warehouse_scan_raw_events.source` trong schema gốc (không
  thấy trong thư mục migrations) — nếu có `CHECK`, thêm migration nới.

### 4.6 Nhân viên biết đã quét xong bằng cách nào — vấn đề chưa có lời giải sẵn

Súng quét kêu bíp. Camera thì không.

⚠️ **Không thể phát âm thanh từ agent.** 🔵 Agent chạy dưới dạng Windows service
(nssm). Windows cô lập service trong **Session 0**, không có quyền phát âm thanh
hay hiện cửa sổ lên màn hình của người dùng đang đăng nhập.

| Phương án | Độ trễ phản hồi | Công sức | Nhận xét |
|---|---|---|---|
| **Màn hình tại bàn** mở trang web hiện mã vừa quét + phát âm thanh (trình duyệt phát được) | 🟡 ~1–1,5 giây | Thấp — 🔵 đã có trang `/dashboard/packing/scan` làm nền | **Đề xuất** — thêm được cả thông tin "đang đóng đơn X, đã 45 giây" |
| Ứng dụng nhỏ chạy ở phiên người dùng, agent báo qua cổng localhost | 🟡 < 200 ms | Trung bình — thêm một chương trình phải cài | Nhanh nhất, nhưng thêm thứ phải bảo trì |
| Đèn/còi báo điều khiển qua mạng (rơ-le IP) | 🟡 < 200 ms | Thấp về code, thêm phần cứng | Hợp môi trường ồn |
| Loa/ngõ ra báo động có sẵn trên camera, gọi qua API của hãng | 🟡 < 300 ms | Phụ thuộc hãng | Chỉ nếu model hỗ trợ |

Nếu dùng màn hình tại bàn: 🔵 trang poll phải dùng `startVisibilityPolling`
(`src/lib/polling/visibility-poller.ts`) — dự án từng bị khoá tài khoản Vercel vì
poll liên tục.

### 4.7 Độ trễ từ lúc giơ nhãn tới lúc hệ thống ghi nhận

🟡 Cộng dồn:

| Chặng | Thời gian |
|---|---|
| Camera mã hoá + truyền RTSP (có `nobuffer/low_delay`) | 150–400 ms |
| Giải mã luồng + trích khung ở 5 khung/giây | 0–200 ms |
| Giải mã QR | 15–40 ms |
| Xác nhận 3 khung | ~400–600 ms |
| Gửi lên cloud | 100–300 ms |
| **Tổng** | **~0,7–1,5 giây** |

Không ảnh hưởng tới cửa sổ clip: 🔵 cửa sổ lùi về trước `video_pre_seconds` = 10
giây mặc định, và `scanned_at` lấy từ lần đầu thấy mã. Nhưng nhân viên sẽ cảm thấy
chậm hơn súng quét — phải đưa vào tiêu chí nghiệm thu.

---

## 5. Luồng 3 — Khi có yêu cầu: cắt 2 góc, ghép chia màn hình, đẩy lên Supabase

### 5.1 Đội cũ đã đi con đường này — dùng lại số đo và bài học

🔵 Migration `20260705120000_reap_timeout_per_type_cut_clip.sql`:

> *Clip cut_clip kẹt vòng lặp taken_count=3, gốc là burn-in reencode mọi clip lúc
> cắt. Clip dài 8–10 phút reencode 16–20 phút → vượt visibility timeout 2 phút của
> reaper → reap kéo về 'pending' → agent claim lại → vòng lặp.*
>
> *Reencode clip 10 phút ≈ 16–20 phút thực tế trên agent kho (i5 hoặc yếu hơn).*

🔵 Migration `20260705140000_revert_cut_clip_timeout_to_default.sql` gỡ bản vá khi
chuyển sang cắt `-c copy`, và để lại lời dặn:

> *Về sau nếu có type reencode thật (VD nếu quyết định thêm lại burn on-demand…) →
> thêm nhánh CASE riêng cho type đó, không nới mặc định.*

🔵 Font tiếng Việt vẫn còn trong `pkg.assets` của agent
(`assets/fonts/NotoSans-Bold.ttf`), và `index.ts` còn comment ghi lại việc từng
"extract font cho burn/mark".

### 5.2 Luồng đầy đủ

```
Người dùng bấm "Xem" trên /dashboard/videos
  │
  ▼
POST /api/order-proof/{pe_id}/watch                       [cloud, poll 2 giây]
  ├─ đã có clip ready → cấp signed URL → phát              (không đổi)
  ├─ đơn còn 'open'   → order_open                         (không đổi)
  ├─ agent offline    → warehouse_offline                  (không đổi)
  └─ chưa có          → enqueueCutClip
        │
        ▼
resolveClipBounds                                          [SỬA]
  - tính cửa sổ (clip-window.ts — không đổi)
  - lấy CẢ 2 camera từ ảnh chụp lúc quét
  - truy vấn segment CHO TỪNG GÓC
  - phân loại từng góc: đủ / thiếu một phần / thiếu hẳn
        │
        ▼
RPC enqueue_clip_generation (1 transaction)                [SỬA payload]
  - row order_proof_clips 'pending' + lệnh cut_clip
        │
        ▼  agent poll (encoding_busy=false → được giao tối đa 1 cut_clip)
AGENT:
  1. Kiểm segment của từng góc còn trên ổ
  2. Báo tiến độ: cutting
  3. Nối segment góc toàn cảnh → wide.raw.mp4   (-c copy, không seek)
  4. Nối segment góc QR        → qr.raw.mp4     (-c copy, không seek)
  5. Báo tiến độ: composing
  6. GHÉP + IN CHỮ + MÃ HOÁ  → {pe}.{cmd}.tmp.mp4   (trong EncodeGate)
       └─ báo tiến độ % mỗi ~15 giây, đồng thời GIA HẠN lệnh
  7. Kiểm file: codec h264, thời lượng, dung lượng ≤ trần
  8. Xoá wide.raw.mp4, qr.raw.mp4
  9. Báo tiến độ: uploading
 10. Xin signed upload URL                          (không đổi)
 11. PUT lên proof-clips-transient/{org}/{pe}/{clip_id}.mp4   (không đổi)
 12. Báo hoàn tất → cloud HEAD kiểm object → RPC promote        (không đổi)
 13. Đổi tên tmp → canonical, lùi được qua .bak/.stale          (không đổi)
```

### 5.3 Cloud: chọn segment cho 2 góc

Sửa `src/lib/order-proof/clip-resolver.ts`:

1. Cửa sổ thời gian **tính một lần**, dùng chung cho 2 góc (🔵 `computeFinalizedClipWindow`).
2. Camera: `proof_camera_id` (toàn cảnh) và `proof_qr_camera_id` (mục 3.4). Dữ liệu
   cũ chưa có cột mới → giải lại bằng hàm resolve theo role.
3. Truy vấn `camera_recording_files` **riêng cho từng camera**, cùng điều kiện hiện
   tại (🔵 lọc 2 mép cửa sổ + `source = 'agent'`).
4. Áp `evaluateOpenSegments` (🔵 luật row mồ côi) **cho từng góc**.
5. Kết quả mỗi góc: `{ role, cameraId, files, status: 'full' | 'partial' | 'missing', gaps }`.

**Luật quyết định:**

| Góc toàn cảnh | Góc QR | Kết quả |
|---|---|---|
| có | có | Ghép 2 góc |
| có | thiếu | **Clip 1 góc** + dòng cảnh báo "KHÔNG CÓ VIDEO GÓC QUÉT MÃ" in trên hình |
| thiếu | có | **Clip 1 góc** + cảnh báo "KHÔNG CÓ VIDEO GÓC TOÀN CẢNH" |
| thiếu | thiếu | Lỗi như hiện tại (`no_segments` / `expired_retention`) |
| segment đang mở (bất kỳ góc) | | `segment_still_open` như hiện tại — thử lại sau |

`is_partial` của clip = **một trong hai góc** thiếu một phần hoặc thiếu hẳn.

### 5.4 Cloud: payload lệnh

Sửa `enqueueCutClip` trong `src/lib/agent-commands/enqueue.ts`:

```jsonc
{
  "packing_event_id": "...",
  "replaces_clip_id": null,
  "target_start": "2026-09-13T07:03:10.000Z",
  "target_end":   "2026-09-13T07:05:55.000Z",

  "angles": [
    {
      "role": "wide",
      "camera_id": "...",
      "camera_label": "Bàn 01 – Toàn cảnh",
      "status": "full",
      "segments": [{ "file_path": "...", "started_at": "...", "ended_at": "..." }],
      "gaps": []
    },
    {
      "role": "qr",
      "camera_id": "...",
      "camera_label": "Bàn 01 – Quét mã",
      "status": "partial",
      "segments": [ ... ],
      "gaps": [{ "from_iso": "...", "to_iso": "...", "gap_seconds": 12 }]
    }
  ],

  "overlay": {
    "waybill_code": "SPXVN066995638828",
    "warehouse_name": "Kho Đại Kim",
    "station": "BAN01 · Bàn đóng gói 01",
    "staff": "NV012 · Nguyễn Văn A",
    "scanned_at": "...",
    "work_duration_seconds": 165,
    "timezone": "Asia/Ho_Chi_Minh"
  },

  "output": { "layout": "side_by_side", "max_bytes": 83886080 },
  "audit": { ... như hiện tại ... }
}
```

🔵 Các trường thông tin đơn **từng bị bỏ khỏi payload ngày 05/07/2026** vì "agent
không dùng — video thuần" (comment trong `enqueue.ts`). Nay đưa lại.

🔵 Thông tin in lên hình lấy **đúng các trường panel đang hiện** trong modal
`/dashboard/videos`: mã vận đơn, Kho, Bàn, Nhân viên, Camera, T/g đóng đơn, Video
bắt đầu, Video kết thúc.

**Dữ liệu cá nhân:** in tên nhân viên lên file gửi cho khách là một quyết định
cần chốt (mục 12). Có thể chỉ in mã nhân viên.

Chữ ký RPC `enqueue_clip_generation` giữ nguyên `p_camera_id` (góc toàn cảnh);
góc QR đi trong `p_command_payload` và `p_generation_params` (đều là `jsonb`) —
**không phải đổi chữ ký RPC**.

### 5.5 Agent: nối segment từng góc — KHÔNG seek ở bước này

**Thay đổi quan trọng so với cách cắt hiện tại.**

🔵 Hiện `cutClip()` dùng `-f concat -i list -ss <offset> -t <dur> -c copy`. Với
`-c copy`, điểm bắt đầu **bị làm tròn về keyframe gần nhất phía trước** — nên clip ra
bắt đầu sớm hơn mốc mong muốn một khoảng không biết trước (tối đa một GOP). Với 1
góc thì vô hại (đã có đệm GOP ±3 giây). **Với 2 góc, mỗi góc tròn về một keyframe
khác nhau → 2 góc lệch nhau một khoảng không đo được.**

**Cách làm đề xuất:**

```
Bước 3–4 (mỗi góc):
  ffmpeg -f concat -safe 0 -i <list> -c copy -an
         -avoid_negative_ts make_zero <góc>.raw.mp4
```

- **Không có `-ss`, không có `-t`.** Nối nguyên các segment.
- Khi đó **thời điểm 0 của file = `started_at` của segment đầu tiên** — biết chính
  xác từ chỉ mục.
- 🔵 `-bsf:v dump_extra` đã được áp khi ghi segment, nên nối được.
- Nhanh: 🟡 vài giây cho vài segment.

Việc cắt chính xác dời sang bước ghép (mục 5.6), nơi dù sao cũng phải giải mã — nên
cắt tới từng khung là **miễn phí**.

### 5.6 Agent: lệnh ghép

**Tính độ lệch cho từng góc:**

```
offset_wide = target_start − wide.segments[0].started_at   (giây, số thực)
offset_qr   = target_start − qr.segments[0].started_at     (+ hiệu chỉnh trễ, mục 5.8)
duration    = target_end   − target_start
```

**Lệnh (bố cục chia đôi ngang + thanh thông tin phía dưới):**

```
ffmpeg -hide_banner -loglevel error -y -progress pipe:1 -nostats
  -ss <offset_wide> -t <duration> -i wide.raw.mp4
  -ss <offset_qr>   -t <duration> -i qr.raw.mp4
  -filter_complex "
    [0:v]fps=25,scale=960:540:force_original_aspect_ratio=decrease,
         pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1[w];
    [1:v]fps=25,scale=960:540:force_original_aspect_ratio=decrease,
         pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1[q];
    [w][q]hstack=inputs=2[s];
    [s]pad=1920:720:0:0:color=black,
       drawtext=fontfile='<đường dẫn font>':textfile='<info.txt>':
                fontsize=30:fontcolor=white:x=24:y=560:line_spacing=10,
       drawtext=fontfile='<đường dẫn font>':
                text='%{pts\:localtime\:<epoch_target_start>\:%d/%m/%Y %H\\\:%M\\\:%S}':
                fontsize=34:fontcolor=yellow:x=w-tw-24:y=560,
       drawtext=...:text='TOÀN CẢNH':x=16:y=16:box=1:boxcolor=black@0.5,
       drawtext=...:text='QUÉT MÃ':x=976:y=16:box=1:boxcolor=black@0.5
    [v]"
  -map "[v]" -an
  -c:v <bộ mã hoá, mục 5.7>
  -pix_fmt yuv420p
  -g 50
  -b:v <bitrate> -maxrate <1.2×bitrate> -bufsize <2×bitrate>
  -movflags +faststart
  {pe}.{cmd}.tmp.mp4
```

**Giải thích các điểm mấu chốt trong lệnh:**

| Điểm | Vì sao |
|---|---|
| `-ss` **trước** `-i` | Đầu vào là file mp4 đơn có index → seek nhanh, và **khi mã hoá lại thì chính xác tới từng khung**. Khác với bước nối concat, nơi 🔵 `-ss` phải đặt sau `-i` (bài học clip 74 giây thay vì 29) — ở đây không dùng concat nên quy tắc đảo lại |
| `fps=25` ở cả 2 nhánh | `hstack` ghép từng cặp khung; 2 luồng lệch fps sẽ trôi dần |
| `scale…decrease` + `pad` | Giữ tỉ lệ khung gốc, không méo hình nếu 2 camera khác độ phân giải |
| `setsar=1` | `hstack` báo lỗi nếu tỉ lệ điểm ảnh 2 nhánh khác nhau |
| `textfile=` thay vì `text=` | Chuỗi tiếng Việt, dấu `:`, `'`, `%`, `\` trong mã vận đơn/tên đều phải thoát ký tự trong filter graph — ghi ra file là tránh hết |
| `%{pts\:localtime\:<epoch>}` | **Đồng hồ chạy theo từng khung**, tính từ `target_start`. Người xem thấy chính xác giờ của mọi khoảnh khắc — giá trị bằng chứng rất cao |
| Đồng hồ `localtime` | Dùng múi giờ máy kho. 🔵 Máy kho đặt giờ Việt Nam (tên file segment đang theo giờ địa phương). ⚠️ Kiểm lại trên máy thật |
| `-progress pipe:1` | ffmpeg in `out_time_ms=…` định kỳ → tính % hoàn thành cho UI |
| `-pix_fmt yuv420p` | Trình duyệt, điện thoại cần định dạng này |
| `-b:v` + `-maxrate` | Dung lượng **đoán trước được** — không còn phụ thuộc bitrate camera |
| `-movflags +faststart` | Phát được ngay khi đang tải, như hiện tại |

**Ba cạm bẫy Windows trong filter graph — đã biết trước:**

1. **Đường dẫn font có ký tự ổ đĩa** `C:\...` — dấu `:` phải thoát thành `C\:/...`
   và dùng dấu `/`. Cách an toàn: đặt font ở đường dẫn tương đối so với thư mục làm
   việc của ffmpeg.
2. **Font nằm trong .exe không đọc được từ ffmpeg.** 🔵 Agent đóng gói bằng pkg;
   file trong `pkg.assets` chỉ Node đọc được qua snapshot ảo. ffmpeg là tiến trình
   ngoài → **phải chép font ra `data/fonts/` lúc khởi động** (đúng việc code cũ từng
   làm).
3. **Filter graph dài vượt giới hạn dòng lệnh** — dùng `-filter_complex_script
   <file>` thay vì truyền chuỗi.

**Thanh thông tin (`info.txt`) — đề xuất nội dung:**

```
SPXVN066995638828   ·   Kho Đại Kim   ·   BAN01
Nhân viên: NV012   ·   Đóng đơn: 2 phút 45 giây
Video: 14:03:10 → 14:05:55  (13/09/2026)
⚠ Góc quét mã thiếu 12 giây (14:04:02 → 14:04:14)      ← chỉ khi có
```

**Trường hợp chỉ có 1 góc:** cùng khung 1920×720, pane còn thiếu hiện nền đen với
chữ cảnh báo lớn. Giữ khung cố định để mọi video bằng chứng có cùng bố cục.

**Bố cục thay thế (quyết định ở mục 12):**

| Bố cục | Kích thước | Ưu | Nhược |
|---|---|---|---|
| **Chia đôi ngang + thanh dưới** (đề xuất) | 1920×720 | 2 góc bằng nhau, chữ không che hình | Tỉ lệ rộng, xem trên điện thoại phải xoay ngang |
| Chia đôi dọc | 960×1260 | Xem điện thoại dọc tốt | Mỗi góc nhỏ khi xem máy tính |
| Góc QR chèn nhỏ vào góc toàn cảnh | 1920×1080 | Tỉ lệ chuẩn, file nhẹ | Góc QR nhỏ, có thể không đọc được mã trên hình |

### 5.7 Chọn bộ mã hoá

**Phát hiện lúc agent khởi động**, lưu kết quả, báo lên cloud qua heartbeat:

1. `ffmpeg -hide_banner -encoders` → có `h264_qsv` / `h264_nvenc` / `h264_amf` không.
2. **Thử mã hoá thật 1 giây** với từng bộ có trong danh sách. ⚠️ Có tên trong danh
   sách **không** có nghĩa là chạy được — thiếu driver GPU thì lỗi lúc chạy.
3. Chọn bộ đầu tiên chạy được theo thứ tự: `h264_qsv` → `h264_nvenc` → `h264_amf`
   → `libx264`.

| Bộ mã hoá | Tham số gợi ý | 🟡 Tốc độ tương đối | CPU |
|---|---|---|---|
| `h264_qsv` (Intel iGPU) | `-preset veryfast` | Nhanh gấp 5–10 lần phần mềm | Thấp |
| `h264_nvenc` (NVIDIA) | `-preset p3` | Nhanh gấp 5–15 lần | Thấp |
| `libx264` (phần mềm) | `-preset veryfast -threads <N>` | Mốc gốc | **Cao** |

**Dự phòng khi chạy:** bộ phần cứng lỗi giữa chừng → thử lại **một lần** bằng
`libx264`, ghi rõ vào `generation_params.encoder_fallback`.

**Với `libx264`:** giới hạn `-threads` = tổng số luồng − 2, để dành chỗ cho giải mã
QR và hệ điều hành. Đặt mức ưu tiên tiến trình thấp bằng `os.setPriority(pid, …)`
của Node sau khi spawn.

⚠️ Kiểm bản ffmpeg trên máy kho có filter `drawtext` (cần thư viện freetype) và bộ
mã hoá `h264_qsv`: `ffmpeg -filters | findstr drawtext` và
`ffmpeg -encoders | findstr qsv`. Các bản dựng "full" của gyan.dev thường có đủ.

### 5.8 Căn thời gian 2 góc

**Nguồn sai số, theo thứ tự lớn → nhỏ:**

| Nguồn | 🟡 Độ lớn | Cách xử lý |
|---|---|---|
| Độ phân giải tên file segment (theo giây) | tới 1 giây | 🔵 Tên file `%Y%m%d_%H%M%S`. Giảm bằng `-segment_atclocktime 1` (mục 3.3) |
| Keyframe khi xoay file `-c copy` | tới 1 GOP | GOP = 1 giây (mục 2.2) |
| Trễ RTSP khác nhau giữa 2 camera | vài chục ms (cùng dòng) | Hiệu chỉnh tĩnh theo bàn |
| Lệch đồng hồ NTP | 0 | 🔵 Hai camera cùng được đóng dấu bởi đồng hồ máy kho → triệt tiêu |

**Hiệu chỉnh tĩnh:** thêm `qr_offset_ms` vào cấu hình bàn (`station_devices.config_json`).
Đo bằng cách cho 2 camera cùng nhìn một đồng hồ hiện mili-giây, so khung.

**Nếu sai số còn lại > 500 ms không chấp nhận được:** phải ghi thời điểm bắt đầu
chính xác của từng segment. Hướng khả thi: thêm `-segment_list <file>.csv
-segment_list_type csv` để ffmpeg ghi thời điểm bắt đầu/kết thúc của từng segment
theo đồng hồ luồng, kết hợp mốc đồng hồ tường lúc spawn. ⚠️ Cần thử nghiệm riêng.

### 5.9 Kiểm file ghép trước khi đẩy

Mở rộng bước kiểm hiện có:

| Kiểm | Cách | Thất bại → |
|---|---|---|
| Codec đầu ra | 🔵 `probeFileVideoCodec` + `isBrowserSafeCodec` (dời từ bước cắt sang đây) | `unsupported_output_codec` |
| Thời lượng | `probeDurationSeconds` so với `duration`, lệch ≤ 1 giây | `duration_mismatch` |
| Kích thước khung | ffprobe `width×height` = 1920×720 | `bad_dimensions` |
| Dung lượng | 🔵 `evaluateClipSize` với `MAX_PROOF_CLIP_UPLOAD_BYTES` (90 MiB) | `clip_too_large` |
| Có khung hình | Dung lượng > 0, ffprobe đọc được | `empty_output` |

**Bitrate tính theo thời lượng để không bao giờ vượt trần:**

```
bitrate_video = min(2500 kbps, floor(0.85 × max_bytes × 8 / duration_seconds / 1000))
```

🟡 Clip 3 phút ở 2,5 Mbps ≈ **54 MiB** (dưới trần 90 MiB). Clip 10 phút tự hạ còn
🟡 ~1 Mbps.

### 5.10 Tiến độ và gia hạn lệnh — thay cho việc nới timeout

🔵 Reaper kéo lệnh `taken` quá **2 phút** về `pending`. Ghép mất vài phút → nhất định
vượt.

Hai cách:

| | Nới timeout cho `cut_clip` (cách cũ đã làm) | **Gia hạn theo tiến độ (đề xuất)** |
|---|---|---|
| Làm | Thêm nhánh `CASE 'cut_clip' THEN interval '30 minutes'` | Mỗi lần agent báo tiến độ, cloud cập nhật `agent_commands.taken_at = now()` cho lệnh đó |
| Agent treo thật | Người dùng chờ oan tới 30 phút | Lệnh bị thu hồi sau 2 phút kể từ lần báo cuối |
| Đúng lời dặn trong migration revert | Một phần | **Đúng hoàn toàn** — không nới mặc định, không che triệu chứng treo |

**Cách làm:**

- Agent đọc `-progress pipe:1`, cứ **~15 giây** gửi một lần
  `POST /api/agent/clip-cut-result` với `outcome: "encoding"` + `stage` + `percent`.
  (15 giây cân bằng giữa độ tươi của UI và số request — 🔵 dự án đã từng vượt hạn
  mức request.)
- Route đó, khi `outcome = "encoding"`, cập nhật thêm
  `agent_commands.taken_at = now()` cho lệnh `cut_clip` có
  `payload->>clip_id = <clip_id>` **và** `status = 'taken'` **và** `agent_id = <agent đã xác thực>`.
- Vẫn nên thêm nhánh `CASE` với trần an toàn (🟡 45 phút) — phòng khi đường gia hạn
  hỏng.

**Mở rộng trạng thái tiến độ:**

- 🔵 Hiện `order_proof_clips.progress_state` có `CHECK (progress_state is null or
  progress_state in ('encoding'))` (migration `20260701163504`). Migration nới:
  `('encoding','cutting','composing','uploading')` + cột `progress_percent smallint`.
- 🔵 Route `/watch` hiện trả `preparing_cut` **không kèm tiến độ** cho lần cắt đầu
  (chỉ lần tạo lại mới có `regeneration_state`). Sửa để trả `progress_state` và
  `progress_percent` cho cả lần đầu.
- `useWatchClipState` + modal hiện "Đang ghép video 2 góc — 45%".

---

## 6. Thắt cổ chai — xếp theo mức nghiêm trọng

| # | Thắt cổ chai | Ở đâu | Biểu hiện | Cách gỡ |
|---|---|---|---|---|
| **1** | **Đọc nhầm mã** | Bộ giải mã QR | Đơn bị đóng sớm, bằng chứng cụt, cảnh báo Lark giả | 6 lớp ở mục 4.1 + chạy bóng 2 tuần |
| **2** | **Thời gian ghép** | Bước 6 ở agent | 🟡 Phần mềm: clip 3 phút mất 7–10 phút | Bộ mã hoá phần cứng; độ phân giải 1920×720 thay vì 3840×1080 |
| **3** | **Một clip một lúc** | 🔵 `EncodeGate` + `encoding_busy` | Hàng đợi 5 yêu cầu × 8 phút = 40 phút cho người cuối | Làm #2 trước; hiện tiến độ + vị trí trong hàng đợi |
| **4** | **Reaper thu hồi lệnh giữa chừng** | 🔵 `reap_stale_agent_commands`, 2 phút | Mã hoá lại từ đầu, vòng lặp `taken_count` | Gia hạn theo tiến độ (5.10) — **bắt buộc làm cùng lúc** |
| **5** | **CPU tranh chấp** | Máy kho | Giải mã QR chạy liên tục + ghép theo yêu cầu cùng lúc | Ưu tiên tiến trình thấp; giới hạn `-threads`; tăng tốc phần cứng |
| **6** | **Ổ đĩa gấp đôi** | Máy kho | Số ngày lưu giảm một nửa ở cùng dung lượng | Ổ lớn hơn; ghi H.265 (3.3b); bitrate camera QR thấp hơn |
| **7** | **Pipe khung hình đầy** | Tiến trình trích khung | Bộ giải mã chậm → ffmpeg dừng | Luôn đọc, vứt khung thừa (4.2) |
| **8** | **Kết nối RTSP đồng thời** | Camera QR | Camera từ chối kết nối thứ hai | Chọn model cho ≥ 2 kết nối; dự phòng chung tiến trình |
| **9** | **Băng thông đẩy lên** | Mạng kho | 🟡 54 MiB ở 5 Mbps ≈ 90 giây | 🔵 `upload.ts` đã có timeout theo dung lượng; chấp nhận |
| **10** | **Đĩa tạm khi ghép** | Máy kho | 2 file raw + 1 file ghép ≈ 🟡 3× clip | Xoá raw ngay sau khi ghép xong |

---

## 7. Tài nguyên theo từng phần

### 7.1 CPU — 🟡 tất cả là ước lượng, đo ở mốc M2 và M4

| Việc | Chạy khi nào | Phần mềm | Có tăng tốc phần cứng |
|---|---|---|---|
| Ghi hình camera toàn cảnh (`-c copy`) | 24/7 | 1–3% một nhân | — |
| Ghi hình camera QR (`-c copy`) | 24/7 | 1–3% một nhân | — |
| Giải mã luồng phụ camera QR (720p25) | 24/7 | 5–10% một nhân | 1–3% |
| Giải mã QR (zxing-wasm, 5 khung/giây) | 24/7 | 8–20% một nhân | — (không có bản GPU) |
| **Tổng nền mỗi bàn** | **24/7** | **~15–35% một nhân** | ~10–25% |
| Nối segment (`-c copy`) | Khi có yêu cầu | Chạy vài giây, I/O | — |
| **Ghép 2 góc 1920×720** | Khi có yêu cầu | **Gần hết các nhân**, 🟡 2–3,5× thời lượng clip | **Thấp**, 🟡 0,2–0,5× thời lượng clip |

**Mốc gốc đo được** 🔵: 1 luồng 1080p + in chữ + mã hoá phần mềm trên i5 = 1,6–2×
thời lượng clip.

**Quy mô máy kho theo số bàn (🟡):**

| Số bàn (2 camera/bàn) | CPU tối thiểu | Điều kiện |
|---|---|---|
| 1–2 bàn | Intel i5 thế hệ 8+ (4 nhân/8 luồng) có iGPU | Dùng QuickSync |
| 3–5 bàn | Intel i5/i7 thế hệ 10+ (6 nhân+) có iGPU | Dùng QuickSync; ROI hẹp để giảm CPU giải mã QR |
| > 5 bàn | i7 thế hệ 12+ hoặc tách 2 máy / 2 agent | ⚠️ 🔵 Hệ thống **chưa hỗ trợ an toàn nhiều agent một tổ chức** (xem mục 9) |

**Không chọn máy không có GPU tích hợp** (Intel dòng "F", ví dụ i5-12400F) nếu không
có card đồ hoạ rời.

### 7.2 RAM

| Thành phần | 🟡 Mức dùng |
|---|---|
| Agent Node.js | 100–200 MB |
| zxing-wasm (mỗi camera QR) | 50–100 MB |
| ffmpeg ghi hình (mỗi camera) | 20–50 MB |
| ffmpeg trích khung (mỗi camera QR) | 50–100 MB |
| ffmpeg ghép (khi có yêu cầu) | 200–500 MB |
| Windows | 2–3 GB |

**Tối thiểu 8 GB, đề xuất 16 GB.**

### 7.3 Ổ đĩa

🔵 Số gốc: camera ~256 KB/s (comment trong `clip-resolver.ts`, suy từ clip 195 giây
≈ 50 MiB).

| Đại lượng | 🟡 1 camera | 🟡 1 bàn (2 camera) | 🟡 5 bàn |
|---|---|---|---|
| Mỗi ngày (24/7) | ~22 GB | ~43 GB | ~216 GB |
| 7 ngày | ~150 GB | ~300 GB | ~1,5 TB |
| **30 ngày** | **~650 GB** | **~1,3 TB** | **~6,5 TB** |
| 30 ngày, ghi H.265 | ~350 GB | ~700 GB | ~3,5 TB |

- 🔵 Thời hạn lưu cấu hình ở `organizations.retention_days` (7–365 ngày). Đây là con
  số nhân trực tiếp với bảng trên — **chốt con số này trước khi mua ổ**.
- Loại ổ: ghi liên tục 24/7 → dùng **ổ HDD dòng giám sát** (surveillance, ví dụ dòng
  chịu tải ghi liên tục) cho segment; **SSD** cho hệ điều hành + thư mục tạm khi ghép.
- Thêm 🟡 ~1–2 GB trống cho file tạm lúc ghép.

### 7.4 Mạng

| Đoạn | Yêu cầu |
|---|---|
| Camera → máy kho (LAN) | 🟡 ~2 Mbps/camera ghi + ~1 Mbps luồng phụ camera QR. Switch gigabit dư sức |
| Máy kho → Internet, nền | Rất thấp: poll 3 giây, heartbeat, probe 30 giây, sự kiện quét |
| Máy kho → Supabase, khi có yêu cầu | 🟡 54 MiB/clip 3 phút; ở 5 Mbps tải lên ≈ 90 giây |

### 7.5 Supabase

| Hạng mục | Thay đổi |
|---|---|
| Storage | Mỗi clip 🟡 ~54 MiB (so với 45–50 MiB hiện tại) — gần như không đổi. 🔵 Bucket vẫn tự dọn sau 72 giờ |
| Database | Thêm vài cột; `warehouse_scan_raw_events` có thêm sự kiện từ camera (cùng số lượng với súng quét nếu lọc trùng tốt) |
| Request | Tiến độ ghép ~15 giây/lần/clip đang chạy — không đáng kể |

### 7.6 Phần cứng theo bàn — tổng hợp

| Hạng mục | Số lượng |
|---|---|
| Camera IP PoE toàn cảnh | 1 |
| Camera IP PoE quét QR (ống kính phù hợp vùng quét, cho ≥ 2 kết nối RTSP) | 1 |
| Cổng switch PoE | 2 |
| Màn hình hiện phản hồi quét (nếu chọn phương án 4.6) | 1 |
| Đèn chiếu vùng quét | 1 |
| **Bỏ:** súng quét | −1 |

---

## 8. Thay đổi code chi tiết

### 8.1 Database (migrations)

| # | Migration | Nội dung |
|---|---|---|
| D1 | `…_packing_events_proof_qr_camera.sql` | Cột `packing_events.proof_qr_camera_id uuid null` + FK `cameras` |
| D2 | `…_resolve_station_camera_by_role.sql` | Hàm tra camera theo `role` tại thời điểm; ⚠️ đọc định nghĩa `resolve_station_camera_at` gốc trước |
| D3 | `…_process_waybill_scan_two_cameras.sql` | Viết lại `process_waybill_scan` ghi thêm `proof_qr_camera_id`. 🔵 Sao nguyên bản mới nhất từ `20260807100000`, chỉ thêm phần mới |
| D4 | `…_order_proof_clips_two_angles.sql` | `qr_camera_id uuid null`, `angles_present text[]`, `layout text`, `progress_percent smallint`; nới `CHECK progress_state` |
| D5 | `…_reap_cut_clip_ceiling.sql` | Nhánh `CASE 'cut_clip'` trần 🟡 45 phút. 🔵 Chép khuôn từ `20260705120000` |
| D6 | `…_scan_source_camera_qr.sql` | ⚠️ Chỉ nếu `warehouse_scan_raw_events.source` có `CHECK` trong schema gốc |
| D7 (nên) | `…_order_proof_clips_sha256.sql` | Cột `sha256 text` — buộc file gửi khách với bản ghi; tính ở agent, cloud lưu lúc promote |

🔵 CI chặn 2 migration trùng version (`scripts/check-migration-versions.mjs`).

### 8.2 Cloud

| File | Thay đổi |
|---|---|
| `src/app/api/warehouse/scans/route.ts` | Thêm `"camera_qr"` vào `ScanSource` |
| `src/app/api/station-devices/route.ts` + `DevicesTab.tsx` + `devices/page.tsx` | Vai trò `proof_qr`; loại thiết bị quét "camera QR" trỏ `source_camera_id` |
| `src/lib/camera/active-credentials.ts` | Trả thêm `qr_decode: { enabled, substream_path, roi, min_width_px }` cho camera role `proof_qr` |
| `src/lib/order-proof/clip-resolver.ts` | Giải 2 góc (5.3) |
| `src/lib/agent-commands/enqueue.ts` | Payload `angles` + `overlay` + `output` (5.4); phát hiện lỗ hổng từng góc |
| `src/app/api/agent/clip-cut-result/route.ts` | Nhận `stage`, `percent`, `angles_present`, `encoder`; **gia hạn `taken_at`** (5.10) |
| `src/app/api/order-proof/[pe_id]/watch/route.ts` | Trả `progress_state` + `progress_percent` cho lần cắt đầu |
| `src/lib/watch/use-watch-clip-state.ts` + `dashboard/videos/page.tsx` | Hiện tiến độ; hiện "thiếu góc" trong panel |
| `src/app/api/warehouse/heartbeat/route.ts` | Nhận `encoder`, `qr_decoders: [{camera_id, fps, last_frame_at, last_decode_at, decode_ms_p95}]` |
| `src/lib/system/checks.ts` + `status-view.ts` | Mục kiểm mới: "bộ giải mã QR còn chạy" — 🔵 theo đúng 3 ràng buộc của file: không throw, chỉ đọc, không đoán số |
| Trang phản hồi tại bàn | Mở rộng 🔵 `/dashboard/packing/scan`: hiện mã vừa quét + âm thanh, poll qua `startVisibilityPolling` |

### 8.3 Agent — module mới

| File | Việc | Thuần (test được)? |
|---|---|---|
| `qr-frame-source.ts` | Spawn ffmpeg trích khung, đọc pipe, gom khung, vứt khung thừa, tự thử lại khi ffmpeg chết | Không |
| `qr-decoder.ts` | Nạp zxing-wasm, giải mã một khung, trả mã + vị trí | Không |
| **`qr-debounce.ts`** | Máy trạng thái lọc trùng + ROI + kích thước tối thiểu (4.4) | **Có** |
| `qr-scan-service.ts` | Ghép 3 file trên cho mỗi camera QR, đẩy vào hàng đợi quét có sẵn | Không |
| **`compose-plan.ts`** | Từ payload → tính offset, duration, bitrate, dựng filter graph, nội dung `info.txt` | **Có** |
| `clip-composer.ts` | Chạy ffmpeg ghép, đọc `-progress`, báo tiến độ, dự phòng bộ mã hoá | Không |
| `encoder-detect.ts` | Phát hiện + thử bộ mã hoá lúc khởi động | Không |
| `font-extract.ts` | Chép font từ snapshot pkg ra `data/fonts/` | Không |

### 8.4 Agent — file sửa

| File | Thay đổi |
|---|---|
| `index.ts` nhánh `cut_clip` | Thay bước 3 (cắt 1 góc) bằng: nối 2 góc → ghép → kiểm; giữ nguyên bước 5–8 (signed URL, PUT, promote, đổi tên) |
| `index.ts` khởi động | Gọi `font-extract`, `encoder-detect`; khởi `qr-scan-service` cho camera có `qr_decode.enabled` |
| `index.ts` shutdown | Dừng `qr-scan-service` trong ngân sách 🔵 4500 ms |
| `clip-cutter.ts` | Thêm hàm nối không seek (`concatWithoutSeek`); giữ `cutClip` cũ cho dữ liệu cũ / dự phòng |
| `heartbeat.ts` | Gửi thêm thông tin bộ mã hoá + trạng thái bộ giải mã QR |
| `config.ts` | Biến môi trường mới (8.5) |
| `package.json` | Thêm `zxing-wasm` (ghim phiên bản); thêm file `.wasm` vào `pkg.assets` |

### 8.5 Biến môi trường mới cho agent

| Biến | 🟡 Mặc định | Ý nghĩa |
|---|---|---|
| `QR_DECODE_ENABLED` | `true` | Tắt nhanh toàn bộ tính năng quét bằng camera |
| `QR_SHADOW_MODE` | `true` | **Mặc định bật.** Gửi sự kiện nhưng đánh dấu không tạo đơn (10.3) |
| `QR_DECODE_FPS` | `5` | Khung/giây đưa vào giải mã |
| `QR_DECODE_WIDTH` | `1280` | Chiều ngang khung giải mã |
| `QR_CONFIRM_FRAMES` | `3` | Số khung liên tiếp để xác nhận |
| `QR_ABSENT_REARM_MS` | `4000` | Vắng bao lâu thì được đọc lại |
| `QR_STAFF_SUPPRESS_MS` | `900000` | Cửa sổ chặn QR nhân viên (15 phút) |
| `QR_MIN_WIDTH_PX` | `100` | Bề rộng mã tối thiểu |
| `COMPOSE_ENCODER` | `auto` | `auto` \| `qsv` \| `nvenc` \| `amf` \| `x264` |
| `COMPOSE_MAX_BITRATE_KBPS` | `2500` | Trần bitrate video ghép |
| `COMPOSE_WIDTH` / `COMPOSE_HEIGHT` | `1920` / `720` | Khung đầu ra |
| `COMPOSE_X264_THREADS` | `số luồng − 2` | Chỉ cho `libx264` |
| `COMPOSE_PROGRESS_INTERVAL_MS` | `15000` | Nhịp báo tiến độ + gia hạn lệnh |

---

## 9. Điểm mấu chốt — những thứ không được làm sai

### Giữ nguyên bất biến đang có (🔵 mỗi cái là một sự cố production)

1. **Ghi hình không phụ thuộc bất cứ thứ gì khác.** Bộ giải mã QR, bước ghép đều ở
   tiến trình riêng.
2. **Luôn đọc stdout của ffmpeg.** Pipe đầy là treo cả tiến trình.
3. **Không bao giờ xoá `desired-recording.json` vì lỗi runtime** — áp cho cả camera QR.
4. **`started_at` của segment lấy từ tên file**, không phải lúc quan sát.
5. **Fail ở bất kỳ bước nào trước khi promote không được chạm file canonical.**
6. **Chỉ RPC `promote_clip_generation` đặt `ready`**, sau khi cloud tự kiểm object.
7. **Chỉ một hàm được ký URL cho bucket clip** (`proof-clip-signed-url.ts`).
8. **Đơn còn `open` thì không cắt** (`proof-clip-gate.ts`) — áp cho clip ghép.
9. **Luôn lọc `organization_id` lấy từ danh tính HMAC**, không từ body.

### Mới cho kế hoạch này

10. **Không phát sự kiện quét từ camera khi chưa qua chạy bóng.** `QR_SHADOW_MODE`
    mặc định bật.
11. **`scanned_at` = lần đầu thấy mã**, không phải lúc xác nhận.
12. **Nối segment không seek; cắt chính xác ở bước ghép.** Đừng dùng lại
    `cutClip` có `-ss` cho từng góc — 2 góc sẽ lệch nhau không đo được.
13. **Với đầu vào mp4 đơn ở bước ghép, `-ss` đặt TRƯỚC `-i`.** Ngược với quy tắc
    concat. Hai quy tắc đúng ở hai chỗ khác nhau — ghi comment rõ ở cả hai chỗ.
14. **Thiếu một góc vẫn ra clip, và phải in cảnh báo lên hình.** Không im lặng.
15. **Gia hạn lệnh theo tiến độ, không nới timeout mặc định.**
16. **Font phải chép ra ổ đĩa**; ffmpeg không đọc được snapshot của pkg.
17. **Bitrate tính theo thời lượng** để không bao giờ vượt trần upload.
18. **Thử mã hoá thật khi phát hiện bộ mã hoá**, đừng tin danh sách `-encoders`.

### ⚠️ Nợ kỹ thuật cũ bị kế hoạch này làm nặng thêm

🔵 `recording.ts` (khối `BLOCKS-GO-LIVE`) ghi rõ: **hệ thống chưa chặn được 2 agent
cùng ghi một camera**, và 🔵 `agent-liveness.ts` giả định **1 tổ chức = 1 agent**.
Kho nhiều bàn dồn CPU lên một máy — nếu phải tách sang 2 máy thì phải xử lý nợ này
trước.

---

## 10. Kiểm thử và đo lường

### 10.1 Test tự động (hàm thuần)

🔵 Theo đúng cách dự án đang làm (`tests/*.test.ts`, TZ mặc định UTC):

| File test | Ca phải có |
|---|---|
| `qr-debounce.test.ts` | Mã giữ yên 10 giây chỉ phát 1 lần · rời vùng 5 giây quay lại được phát lại · mã lướt 1–2 khung không phát · mã nhỏ dưới ngưỡng bị bỏ · mã ngoài ROI bị bỏ · 2 mã khác nhau cùng khung · QR nhân viên bị chặn cửa sổ dài · `scanned_at` = khung đầu tiên |
| `compose-plan.test.ts` | Offset đúng khi 2 góc bắt đầu segment khác giây · thiếu góc QR → bố cục 1 góc + dòng cảnh báo · bitrate tự hạ với clip 10 phút · ký tự `:` `'` `%` `\` và tiếng Việt trong `info.txt` · đường dẫn Windows có ổ đĩa |
| `clip-resolver` (mở rộng) | 4 tổ hợp đủ/thiếu của mục 5.3 · row mồ côi ở một góc không chặn góc kia |

### 10.2 Thử bộ giải mã trên video đã ghi — trước khi đụng tới production

**Tận dụng segment đã có trên ổ.** Viết một công cụ dòng lệnh chạy bộ giải mã +
máy trạng thái lọc trùng trên file mp4 thay vì camera trực tiếp, xuất CSV
`thời điểm, mã, số khung, bề rộng`. Đối chiếu với `warehouse_scan_raw_events` của
súng quét cùng khoảng thời gian.

Cho phép tinh chỉnh `CONFIRM_FRAMES`, `ABSENT_REARM_MS`, ROI, `MIN_WIDTH_PX` **lặp đi
lặp lại trên cùng dữ liệu** mà không cần ai đứng ở kho.

### 10.3 Chạy bóng — bắt buộc trước khi bỏ súng quét

- Súng quét vẫn là nguồn chính thức.
- Camera gửi sự kiện với `source = "camera_qr"` + cờ bóng → cloud **ghi vào
  `warehouse_scan_raw_events` nhưng không gọi `process_waybill_scan`**.
- Mỗi ngày đối chiếu tự động 2 nguồn theo bàn và theo cửa sổ ±5 giây.

### 10.4 Tiêu chí nghiệm thu

| Chỉ số | 🟡 Ngưỡng đề xuất | Đo từ |
|---|---|---|
| Tỉ lệ đọc được (so với súng quét) | ≥ 99,5% | Chạy bóng |
| **Đọc nhầm tạo đơn giả** | **0 trong 2 tuần** | Chạy bóng — sự kiện camera không có súng quét tương ứng |
| Đọc lặp cùng mã | ≤ 0,5% | Chạy bóng |
| Trễ quét p95 (giơ nhãn → sự kiện) | ≤ 1,5 giây | Chạy bóng, so thời điểm 2 nguồn |
| Thời gian ghép clip 3 phút, p95 | ≤ 3 phút | `generation_params` |
| Lệch 2 góc | ≤ 500 ms | Thử đồng hồ mili-giây |
| CPU nền máy kho | ≤ 50% | Heartbeat |
| Ghi hình mất segment | 0 | 🔵 Mục tự kiểm "độ tươi ghi hình" hiện có |

---

## 11. Lộ trình

| Mốc | Nội dung | 🟡 Thời gian | Điều kiện qua mốc |
|---|---|---|---|
| **M0 — Khảo sát** | Đo mã QR/1D trên nhãn thật · kiểm model camera cho ≥ 2 kết nối RTSP + luồng phụ 720p · `ffmpeg -encoders`, `-filters` trên máy kho · CPU/RAM/ổ hiện có · tốc độ tải lên | 2–3 ngày | Có số đo mục 2.1 và 7 |
| **M1 — Ghi hình 2 camera** | Lắp camera QR, cấu hình GOP/màn trập/OSD · vai trò `proof_qr` · migration D1–D3 | 1 tuần | Cả 2 camera ghi ổn định 3 ngày; `packing_events` chụp đủ 2 camera |
| **M2 — Bộ giải mã ngoại tuyến** | `qr-debounce`, `qr-decoder` · công cụ chạy trên file mp4 (10.2) · đo tốc độ zxing-wasm | 1–1,5 tuần | Tỉ lệ đọc ≥ 99% và 0 đọc nhầm trên 3 ngày video đã ghi |
| **M3 — Ghép clip** | `compose-plan`, `clip-composer`, `encoder-detect`, `font-extract` · payload 2 góc · migration D4, D5 · gia hạn lệnh | 2 tuần | Clip 3 phút ghép p95 ≤ 3 phút; lệch 2 góc ≤ 500 ms; 4 tổ hợp thiếu góc ra đúng |
| **M4 — Tiến độ + giám sát** | UI tiến độ · mục tự kiểm bộ giải mã · heartbeat mở rộng | 3–4 ngày | Modal hiện đúng giai đoạn; tắt bộ giải mã thì cảnh báo xuất hiện |
| **M5 — Chạy bóng** | Bật `qr-scan-service` ở chế độ bóng tại 1 bàn · trang phản hồi tại bàn | **2 tuần** | Đạt toàn bộ tiêu chí 10.4 |
| **M6 — Chuyển đổi** | Tắt `QR_SHADOW_MODE` tại bàn thử · giữ súng quét dự phòng 1 tuần · rồi mở rộng | 1 tuần + mở rộng dần | Không có sự cố trong 1 tuần |

**Tách được:** M3 (ghép clip) **không phụ thuộc** M2/M5 (quét bằng camera). Nếu cần
có clip ghép sớm, làm M0 → M1 → M3 → M4 trước, **giữ súng quét**, rồi làm M2 → M5 → M6
sau. Phần giá trị nhất đến sớm, phần rủi ro nhất có thời gian chạy bóng đầy đủ.

---

## 12. Quyết định cần chốt

| # | Câu hỏi | Ảnh hưởng tới |
|---|---|---|
| 1 | Nhãn vận đơn đọc bằng **QR hay barcode 1D**? Mã QR rộng bao nhiêu cm, bao nhiêu module? | Chọn camera, ống kính, độ phân giải giải mã, tính khả thi R2 |
| 2 | Bố cục video ghép: **chia đôi ngang / dọc / chèn góc nhỏ**? | Kích thước khung, dung lượng, CPU ghép |
| 3 | In **tên nhân viên** hay chỉ **mã nhân viên** lên video gửi khách? | Dữ liệu cá nhân |
| 4 | Nhân viên nhận **phản hồi đã quét** bằng gì: màn hình tại bàn / đèn còi / ứng dụng? | Phần cứng mỗi bàn, M5 |
| 5 | `retention_days` bao nhiêu ngày? | Dung lượng ổ (mục 7.3) — nhân trực tiếp |
| 6 | Cho phép camera **ghi H.265** không? | Giảm ~một nửa ổ, tăng CPU giải mã khi ghép |
| 7 | Quét lại **cùng QR nhân viên tại cùng bàn** thì RPC làm gì? ⚠️ Đọc `process_staff_qr_session` trong schema gốc | Rủi ro chấm ra ca ngoài ý muốn (4.1) |
| 8 | Lệch 2 góc bao nhiêu thì chấp nhận? | Có phải làm ghi thời điểm segment chính xác (5.8) |
| 9 | Có tính **SHA-256** cho file ghép để đối chứng khi khách khiếu nại không? | Migration D7 |
| 10 | Kho nhiều bàn dùng **một máy mạnh** hay **nhiều máy**? | Nợ kỹ thuật "nhiều agent một tổ chức" (mục 9) |

---

## 13. Cập nhật theo cấu hình thực tế: Hikvision toàn cảnh + Dahua quét QR + vùng quét riêng

Mục này **ghi đè** các chỗ tương ứng ở trên: 2.2 (cấu hình camera), 4.1 (chống đọc
nhầm), 4.4 (máy trạng thái), 5.8 (căn thời gian).

### 13.1 Hệ thống đã chạy đúng cặp hãng này trong production

🔵 Kho Đại Kim đang ghi hình bằng **`hik_01` (Hikvision)** và **`dahua_01` (Dahua)** —
nhắc tới nhiều lần trong `warehouse-agent/src/recording-lifecycle.ts`,
`warehouse-agent/src/recording.ts`, `src/lib/order-proof/open-segment-verdict.ts`.

Nghĩa là: **cả hai hãng đã được kiểm chứng đi qua toàn bộ đường ghi hình → chỉ mục
segment → cắt clip**. Không có rủi ro "hãng lạ". Và code đã ghi lại những đặc điểm
thật của từng hãng:

| Đặc điểm đã biết | Nguồn | Ảnh hưởng tới kế hoạch |
|---|---|---|
| **Dahua bơm hàng nghìn dòng `Non-monotonic DTS`** vào stderr | 🔵 `recording.ts` (hàm `stripNoisyFfmpegLines`) | Dấu thời gian luồng Dahua **không đơn điệu** → rủi ro khi nối segment và khi căn 2 góc (13.5). Tiến trình trích khung QR cũng sẽ bị bơm log → dùng `-loglevel error` + cùng bộ lọc |
| Chuỗi số trong dòng DTS của Dahua từng bị đọc nhầm thành mã lỗi `404` → xoá ý định ghi | 🔵 `recording-lifecycle.ts` (sự cố 29/07/2026) | Đã vá. Bộ phân loại lỗi hiện neo theo ngữ cảnh — áp dụng luôn cho tiến trình trích khung |
| `dahua_01` từng để lại row segment mồ côi chặn 92 đơn | 🔵 `open-segment-verdict.ts` | Đã vá bằng luật tuổi 10 phút — áp dụng **cho từng góc** (5.3) |
| Đường RTSP 2 hãng đã có preset | 🔵 `src/lib/camera/rtsp-presets.ts` | Hikvision `/Streaming/Channels/101`; Dahua `/cam/realmonitor?channel=1&subtype=0` |

### 13.2 Quy trình "1 vùng, 1 mã, xong mới tới mã tiếp" — giải quyết được gì

| Rủi ro ở mục 4.1 | Quy trình mới xử lý | Còn lại gì |
|---|---|---|
| Kiện tiếp theo nằm sẵn trong tầm nhìn → đóng sớm đơn đang đóng gói | ✅ **Loại gần hết** — Dahua chỉ nhìn vùng quét | Nhân viên vi phạm lúc cao điểm (đặt 2 kiện vào vùng) |
| Nhiều mã trong một khung | ✅ Loại theo quy trình | Cần **kiểm ở code** để phát hiện khi bị vi phạm |
| Kiện vừa quét còn nằm trong vùng → đọc lặp | ⚠️ **Không tự hết** | Nhãn nằm yên trong vùng vẫn bị đọc mỗi khung — máy trạng thái phải giữ |
| Tay che nhãn thoáng qua rồi nhãn hiện lại | ❌ Không xử lý | Nếu coi "vừa khuất" là "đã rời vùng" → đọc lặp → `duplicated` + **cảnh báo Lark cho khách** |
| Thẻ QR nhân viên lọt vào vùng | ✅ Giảm mạnh (vùng hẹp, không đeo ngang tầm) | Vẫn giữ luật chặn riêng cho QR nhân viên |

🔵 **Quy trình khớp sẵn với nghiệp vụ hiện tại.** `process_waybill_scan` đóng đơn
đang mở **khi có mã hợp lệ tiếp theo** — tức "xong đơn này thì mã sau mới vào" chính
là cách hệ thống đã hiểu một ca đóng gói. Không phải đổi luật đóng đơn.

**Nguyên tắc: quy trình giảm rủi ro, code biến quy trình thành điều kiện kiểm được.**
Quy trình dựa vào con người tuân thủ; lúc đông đơn sẽ có lúc bị vi phạm. Nên agent
không *tin* là chỉ có 1 mã — agent **kiểm** điều đó, **từ chối** khi sai, và **đếm**
số lần sai để người quản lý thấy.

### 13.3 Máy trạng thái vùng quét — thay cho mục 4.4

Đơn giản hơn bản ở 4.4 vì có giả định "một vùng, một mã". File thuần
`warehouse-agent/src/qr-zone.ts`, test được.

```
                  1 mã X, liên tiếp đủ K khung
     ┌───────┐  ─────────────────────────────►  ┌────────────┐
     │ TRỐNG │                                   │ ĐANG GIỮ X │  ← PHÁT sự kiện X
     └───────┘  ◄─────────────────────────────  └────────────┘     (scanned_at = khung
         ▲        X vắng liên tục ≥ ZONE_CLEAR_MS        │            đầu tiên thấy X)
         │                                              │
         │                                              │ X vẫn còn → giữ nguyên,
         │                                              │ KHÔNG phát lại
         │                                              │
         │                                              │ mã Y ≠ X xuất hiện
         │                                              │ → KHÔNG nhận Y
         │                                              │ → đếm vi_pham_vung_chua_trong
         │
   Khung có ≥ 2 mã khác nhau ở BẤT KỲ trạng thái nào:
     → bỏ khung, không đổi trạng thái, đếm vi_pham_nhieu_ma
```

| Tham số | 🟡 Mặc định | Vì sao con số này |
|---|---|---|
| `QR_DECODE_FPS` | **10** (ghi đè giá trị 5 ở mục 8.5) | Nhân viên chỉ **giơ nhãn thoáng qua** (mục 13.10) — cần bắt kịp trong ~1 giây. CPU không tăng gấp đôi nhờ chỉ giải mã khi có vật trong vùng (13.10.4) |
| `QR_CONFIRM_FRAMES` (K) | **2** (≈ 0,2 giây ở 10 khung/giây) | Vùng quét riêng + mỗi lần một mã đã loại phần lớn nguồn đọc nhầm, nên hạ được K để kịp bắt lần giơ nhãn ngắn |
| `QR_ZONE_CLEAR_MS` | **1500** | Đủ dài để **tay che nhãn thoáng qua không bị hiểu là đã rời vùng**; đủ ngắn để nhân viên không phải chờ |
| `QR_SAME_CODE_SUPPRESS_MS` | **60000** | Sau khi đã phát X, **cùng mã X** đưa lại trong 60 giây vẫn không phát. Loại đọc lặp do rung tay/đặt lại nhãn. Sau 60 giây thì phát bình thường → cloud đánh `duplicated` — **giữ nguyên tín hiệu "đóng trùng đơn" có thật** cho nghiệp vụ |
| `QR_STAFF_SUPPRESS_MS` | 900000 (15 phút) | QR nhân viên: chặn dài vì quét lại thẻ có thể gây ra ca |
| `QR_REQUIRE_EMPTY_ZONE` | `false` | `false`: X vắng đủ 1,5 giây là nhận mã mới (kể cả Y đã nằm sẵn — Y phải đủ K khung mới). `true`: vùng phải **hoàn toàn trống** mới nhận mã mới — chặt hơn, nhưng nhân viên đổi nhãn nhanh sẽ bị "không nhận" |

**Vì sao `scanned_at` vẫn là khung đầu tiên thấy mã:** nếu lấy lúc xác nhận xong,
mọi mốc quét trễ thêm ~0,6 giây một cách hệ thống — cộng dồn vào thống kê thời gian
đóng đơn.

**Đếm vi phạm gửi qua heartbeat** (`vi_pham_nhieu_ma`, `vi_pham_vung_chua_trong`,
`doc_lap_bi_chan`) → hiện trên trang tình trạng hệ thống và mục tự kiểm. Đây là cách
**đo xem quy trình có được tuân thủ thật không**.

### 13.4 Cấu hình trên từng camera

⚠️ Tên mục trong giao diện web khác nhau theo đời firmware — tên dưới đây là tên
thường gặp, cần dò trên máy thật.

| Thiết lập | Hikvision (toàn cảnh) | Dahua (quét QR) | Vì sao |
|---|---|---|---|
| Codec | **H.264** — chỉnh tay, nhiều model mới mặc định H.265 | **H.264** | 🔵 Đường cắt 1 góc cũ vẫn chặn khác H.264 (`clip-cutter.ts`); đồng bộ 2 camera cho đơn giản. Chỉ chuyển H.265 sau khi đo (mục 3.3b) |
| Khoảng keyframe | Configuration → Video → **I Frame Interval** = số fps | Setting → Camera → Video → **I Frame Interval** = số fps | Cắt/căn chính xác tới 1 giây |
| Smart codec | **H.264+ / H.265+ = TẮT** | **Smart Codec = TẮT** | Kéo dài GOP động |
| Khung/giây | 25 | 25 | Ghép 2 luồng cùng fps |
| Luồng chính | 1080p hoặc 4MP | 1080p | Ghi hình |
| **Luồng phụ** | Không cần | **720p (1280×720)** nếu model hỗ trợ | Dùng để giải mã QR. Một số model Dahua chỉ cho luồng phụ D1/VGA → khi đó giải mã từ luồng chính |
| **Màn trập** | Tự động | **Thủ công, ≤ 1/500 giây** (Exposure → Manual) | Nhãn đang di chuyển không bị nhoè |
| Chống ngược sáng (WDR) | Bật nếu có cửa sổ/đèn mạnh | Tắt nếu vùng quét đủ sáng đều | WDR có thể làm giảm tương phản mã |
| Chữ giờ trên hình (OSD) | **TẮT** | **TẮT** (Overlay → Time Title) | Tránh 3 đồng hồ khác nhau trên video bằng chứng |
| NTP | Đồng bộ nếu vẫn để OSD | Đồng bộ nếu vẫn để OSD | |
| Số kết nối RTSP đồng thời | ≥ 1 | ⚠️ **≥ 2 bắt buộc** — kiểm trước khi mua | Ghi hình + giải mã QR |

**Đường dẫn RTSP:**

| | Ghi hình (`cameras.rtsp_path`) | Giải mã QR |
|---|---|---|
| Hikvision | `/Streaming/Channels/101` | — |
| Dahua | `/cam/realmonitor?channel=1&subtype=0` | `/cam/realmonitor?channel=1&subtype=1` |

🔵 Nhập đường luồng phụ bằng tay thì ô chọn hãng trên form sẽ rơi về "Khác / nhập
tay" (`detectPreset` chỉ nhận `subtype=0`) — chỉ ảnh hưởng hiển thị. Đường luồng phụ
nên lưu ở cấu hình giải mã (`qr_decode.substream_path`, mục 8.2), **không** thay
`rtsp_path` ghi hình.

### 13.5 Căn thời gian 2 góc khác hãng — thay cho mục 5.8

Hai hãng khác nhau → khác bộ mã hoá, khác độ đệm, khác độ trễ. Chênh lệch **có cấu
trúc và cố định theo cặp camera**, không nhỏ và đối xứng như 2 camera cùng dòng.

| Nguồn sai số | 🟡 Độ lớn | Xử lý |
|---|---|---|
| Trễ RTSP khác nhau giữa Hikvision và Dahua | **100–400 ms, cố định theo cặp** | **Hiệu chỉnh `qr_offset_ms` theo từng bàn — BẮT BUỘC**, không còn là tuỳ chọn |
| Tên file segment theo giây | tới 1 giây | `-segment_atclocktime 1` (mục 3.3a) |
| Keyframe | tới 1 GOP | I Frame Interval = fps |
| **DTS không đơn điệu của Dahua** | ⚠️ Chưa đo — **có thể trôi dần trong clip dài** | Xem dưới |

**Rủi ro riêng của Dahua — trôi thời gian trong clip dài.** 🔵 Dấu thời gian luồng
Dahua không đơn điệu. Khi nối nhiều segment rồi seek bằng thời gian, một luồng có
dấu thời gian nhảy lùi có thể khiến **góc QR lệch dần so với góc toàn cảnh** càng về
cuối clip — đầu clip khớp, cuối clip lệch.

Biện pháp:

1. Bước nối segment góc Dahua thêm `-fflags +genpts` để ffmpeg **tự sinh lại** dấu
   thời gian.
2. Bước ghép giữ `fps=25` ở cả 2 nhánh (đã có ở 5.6) — bộ lọc này chuẩn hoá thời
   gian đầu ra theo khung, nhân đôi/bỏ khung khi cần.
3. **Phép thử trôi** ở mốc M3 — không chỉ thử lệch lúc đầu:

   > Cho cả 2 camera nhìn một đồng hồ mili-giây. Ghi **10 phút**. Ghép clip 10 phút.
   > So lệch 2 góc ở **phút 0, phút 5, phút 10**. Lệch đầu = `qr_offset_ms`.
   > **Lệch cuối khác lệch đầu > 200 ms = có trôi** → không dùng được seek theo thời
   > gian cho góc Dahua, phải căn theo thời điểm bắt đầu **từng segment** (cắt từng
   > segment riêng rồi nối trong bước ghép).

**Mức độ quan trọng thực tế:** góc Dahua chỉ chứng minh **mã nào được quét lúc
nào**; góc Hikvision chứng minh **hành động đóng gói**. Lệch dưới 0,5 giây không làm
sai giá trị bằng chứng. Nhưng trôi vài giây ở cuối clip thì có — nên phải đo.

### 13.6 Kích thước vùng quét

Tính theo mục 2.1, 🟡 cho mã QR rộng 3 cm, loại 33×33 module, cần ≥ 100–130 điểm ảnh
trên mã:

| Dahua giải mã từ | Vùng quét tối đa (bề ngang × bề dọc khung 16:9) |
|---|---|
| Luồng phụ 1280×720 | **~30–38 cm × 17–21 cm** |
| Luồng chính 1920×1080 | ~44–57 cm × 25–32 cm |

⚠️ **Đo mã QR thật trên nhãn SPX trước** (mục 12, câu 1). Mã nhỏ hơn 3 cm thì vùng
quét phải hẹp hơn tương ứng.

Gợi ý bố trí:
- Đánh dấu vùng quét trên mặt bàn **nhỏ hơn vùng nhìn thật của Dahua** khoảng 20% mỗi
  cạnh — nhãn đặt lệch mép vẫn nằm trọn trong khung.
- Đặt ROI giải mã **đúng bằng vùng đánh dấu** — mã nằm ngoài vạch không bao giờ được
  đọc, kể cả lọt vào mép khung hình.
- Chiếu sáng riêng cho vùng quét; tránh đèn rọi thẳng gây loá trên màng bọc nilon.
- **Nên để Hikvision toàn cảnh nhìn thấy cả vùng quét** — video ghép khi đó cho thấy
  hành động đặt nhãn từ 2 góc, người xem tự đối chiếu được.

### 13.7 Phản hồi cho nhân viên càng quan trọng hơn

Quy trình "xong mới đưa mã tiếp" chỉ vận hành được khi nhân viên **biết** mã đã được
nhận. Nếu không biết, họ sẽ giữ nhãn lâu hơn hoặc đưa lại — gây đọc lặp.

Màn hình tại bàn (mục 4.6) nên hiện rõ 3 trạng thái, đổi màu toàn màn hình:

| Màn hình | Nghĩa |
|---|---|
| 🟢 **ĐÃ NHẬN** `SPXVN0669…` + tiếng báo | Lấy nhãn ra, đóng gói |
| ⚪ **SẴN SÀNG** | Vùng trống, đưa mã tiếp theo |
| 🔴 **CÓ 2 MÃ TRONG VÙNG** | Vi phạm — lấy bớt ra |

⚠️ Trạng thái 🔴 và ⚪ là **trạng thái tức thời** của vùng quét. Đẩy chúng qua cloud
tốn một request mỗi lần đổi trạng thái và trễ ~1 giây. Hai lựa chọn:

- **Chỉ hiện 🟢 qua cloud** (sự kiện quét đã có sẵn) — rẻ, đủ dùng cho vận hành.
- **Hiện đủ 3 trạng thái** bằng ứng dụng nhỏ chạy ở phiên người dùng trên máy tại
  bàn, agent báo qua `localhost` — tức thì, nhưng thêm một chương trình phải cài.

Khuyến nghị: bắt đầu bằng 🟢 qua cloud, bổ sung ứng dụng cục bộ nếu chạy bóng cho
thấy tỉ lệ vi phạm cao.

### 13.8 Thay đổi so với kế hoạch gốc

| Hạng mục | Kế hoạch gốc | Sau cập nhật |
|---|---|---|
| Rủi ro R2 | Cao | **Trung bình** |
| Chống đọc nhầm | 6 lớp | Máy trạng thái vùng quét (13.3) + ROI + đếm vi phạm |
| Hiệu chỉnh lệch 2 góc | Tuỳ chọn | **Bắt buộc**, theo từng bàn |
| Phép thử căn thời gian | Lệch đầu clip | **Lệch đầu + trôi trong clip 10 phút** |
| Bước nối segment góc Dahua | `-c copy` | `-c copy` + `-fflags +genpts` |
| Chạy bóng (M5) | 2 tuần | 🟡 **Có thể rút xuống 1 tuần** nếu tuần đầu đạt 0 đọc nhầm và tỉ lệ vi phạm quy trình < 1% |
| Tiêu chí nghiệm thu thêm | — | `vi_pham_nhieu_ma` + `vi_pham_vung_chua_trong` < 1% số lần quét |
| Tổng thời gian | 🟡 6–9 tuần | 🟡 **5–8 tuần** |

### 13.9 Quyết định thêm cần chốt

| # | Câu hỏi | Ảnh hưởng tới |
|---|---|---|
| 11 | Model Dahua cụ thể là gì — **có luồng phụ 720p và cho ≥ 2 kết nối RTSP** không? | Giải mã từ luồng phụ hay luồng chính → CPU và kích thước vùng quét |
| 12 | `QR_REQUIRE_EMPTY_ZONE`: nhận mã mới khi mã cũ vắng 1,5 giây, hay phải **vùng trống hoàn toàn**? | Độ chặt quy trình so với tốc độ thao tác |
| 13 | Hikvision có nhìn thấy vùng quét không? | Giá trị đối chiếu của video ghép |
| 14 | Phản hồi tại bàn: chỉ trạng thái 🟢 qua cloud, hay đủ 3 trạng thái bằng ứng dụng cục bộ? | Phần mềm cài thêm ở bàn |

### 13.10 Quy trình giơ nhãn thoáng qua

**Quy trình đã chốt:** nhân viên **giơ nhãn vào vùng quét** để Dahua đọc mã QR và
chụp rõ thông tin đơn, **rồi lấy nhãn ra**. Nhãn không nằm lại trong vùng.

#### 13.10.1 Làm rõ: giơ nhãn là đánh dấu mốc bắt đầu đơn, không phải bật ghi hình

🔵 Cả hai camera **ghi hình liên tục 24/7** (mục 3.1). Lần quét mã chỉ tạo
`packing_event` với `scanned_at` — **mốc bắt đầu của đơn** — và đóng đơn trước đó.
Không có lệnh bật/tắt ghi hình theo từng đơn.

Điều này quan trọng: 🔵 cửa sổ clip **lùi về trước** `scanned_at` một khoảng
`video_pre_seconds` (mặc định 10 giây, `clip-resolver.ts`). Nếu camera chỉ bắt đầu
ghi khi thấy mã, clip sẽ mất 10 giây trước lúc quét và mất luôn cơ chế bù chỉ mục
khi agent khởi động lại. **Giữ ghi 24/7.**

#### 13.10.2 Những gì quy trình này giải quyết thêm

| Rủi ro | Trước | Sau khi nhãn được lấy ra ngay |
|---|---|---|
| Nhãn nằm yên trong vùng bị đọc lặp | Phải giữ bằng máy trạng thái | **Gần như không còn** |
| Vùng quét có vật lạ | Có thể | Vùng **trống ~95% thời gian** → dùng được để tiết kiệm CPU (13.10.4) |
| Không biết khoảnh khắc nào nhãn rõ nhất | Không xác định | **Khung giải mã được mã QR chính là khung nét** → dùng làm ảnh nhãn (13.10.5) |

#### 13.10.3 Rủi ro mới: giơ quá nhanh thì không đọc được

Nhãn chỉ ở trong vùng khoảng **1–2 giây**, và phần lớn thời gian đó là **đang di
chuyển vào/ra** (nhoè). Khoảng nhãn đứng yên rõ nét có thể chỉ vài trăm mili-giây.

Nếu không đọc được: không có `packing_event` → đơn **không tra được bằng mã vận
đơn**, dù video vẫn được ghi. Đây là loại lỗi im lặng — không ai biết cho tới lúc
khách khiếu nại.

🟡 Ngân sách thời gian để kịp bắt:

| Chặng | Thời gian |
|---|---|
| Trễ luồng phụ Dahua (có `nobuffer/low_delay`) | 150–400 ms |
| Chờ khung kế tiếp ở 10 khung/giây | 0–100 ms |
| Giải mã QR | 15–40 ms/khung |
| Xác nhận K = 2 khung | ~100–200 ms |
| **Tổng tới lúc agent phát sự kiện** | **~0,3–0,75 giây sau khi nhãn đứng yên** |
| + Lên cloud + màn hình tại bàn đổi 🟢 | + ~0,5–1 giây |

**Biện pháp:**

1. **Màn trập Dahua ≤ 1/500 giây, tốt hơn 1/1000** (mục 13.4) — quyết định số khung
   nét trong lúc nhãn đang di chuyển.
2. **Tấm đỡ/khung trình nhãn cố định** tại vùng quét: nhân viên áp nhãn vào một mặt
   phẳng ở khoảng cách cố định thay vì giơ lơ lửng. Camera IP thường **không tự lấy
   nét theo vật ở gần** — cố định khoảng cách thì chỉnh nét một lần là xong, và nhãn
   có một khoảnh khắc đứng yên tự nhiên.
3. **Quy tắc thao tác: giữ nhãn tới khi màn hình báo 🟢 rồi mới lấy ra.** Không có
   phản hồi thì quy trình này không vận hành được — màn hình tại bàn (13.7) trở
   thành **bắt buộc**, không còn là tuỳ chọn.
4. Đếm **"vật vào vùng nhưng không đọc được mã"** (13.10.4) gửi qua heartbeat —
   phát hiện lần giơ nhãn bị trượt thay vì để im lặng.

#### 13.10.4 Chỉ giải mã khi có vật trong vùng — tiết kiệm CPU

Vùng quét trống gần như cả ngày. Không cần chạy bộ giải mã QR trên khung trống.

```
Mỗi khung (10 khung/giây):
  1. Thu nhỏ vùng ROI xuống ~160×90, tính chênh lệch trung bình với ảnh nền   ← rẻ, < 1 ms
  2. Chênh lệch < ngưỡng        → vùng trống → BỎ QUA giải mã
     Chênh lệch ≥ ngưỡng        → có vật     → chạy zxing-wasm trên ROI
  3. Ảnh nền cập nhật chậm khi vùng trống lâu (bù thay đổi ánh sáng trong ngày)
```

🟡 Hệ quả: CPU giải mã QR khi vùng trống **gần bằng 0**; chỉ tốn trong ~1–2 giây mỗi
lần giơ nhãn. Tăng lên 10 khung/giây mà CPU trung bình **thấp hơn** bản 5 khung/giây
giải mã liên tục ở mục 7.1.

Kèm theo một chỉ số giá trị: **số lần "có vật vào vùng ≥ 0,5 giây nhưng không đọc
được mã nào"** → phát hiện giơ nhãn trượt, nhãn mờ, mã bị gấp/rách.

⚠️ Ngưỡng chênh lệch phải chỉnh tại hiện trường — bóng người đi ngang, đèn nhấp
nháy có thể kích hoạt. Kích hoạt nhầm chỉ tốn CPU, không gây đọc nhầm mã.

Tiến trình ffmpeg trích khung vẫn phải giải mã luồng H.264 liên tục (không bỏ được —
khung sau phụ thuộc khung trước). Phần tiết kiệm nằm ở bộ giải mã QR.

#### 13.10.5 Ảnh nhãn rõ nét trong video ghép — thay đổi đáng giá nhất

**Vấn đề của bố cục chia đôi ở mục 5.6:** nhãn chỉ ở trong vùng 1–2 giây, trong khi
clip dài 2–3 phút. Nửa màn hình Dahua sẽ **chiếu vùng bàn trống ~98% thời lượng
video**. Người xem muốn đọc thông tin đơn phải tua đúng 1–2 giây đó.

**Đề xuất: chụp ảnh nhãn tại khoảnh khắc đọc được mã, hiện ảnh tĩnh suốt video.**

**Dữ liệu cần có — không phải thêm migration:**

🔵 `packing_events.raw_event_id` trỏ tới `warehouse_scan_raw_events`, và bảng đó đã
có cột `device_identity_snapshot` kiểu `jsonb` (route `/api/warehouse/scans` đang
lưu). Agent ghi thêm vào đó khi phát sự kiện:

```jsonc
"device_identity_snapshot": {
  "camera_id": "<dahua>",
  "decoder": "zxing-wasm@x.y.z",
  "best_frame_at": "2026-09-13T07:03:11.420Z",   // khung giải mã có mã QR to nhất trong chuỗi
  "qr_box": { "x": 512, "y": 240, "w": 148, "h": 150 },
  "decode_frame_size": { "w": 1280, "h": 720 },
  "frames_seen": 6
}
```

**Vì sao "khung có mã QR to nhất":** mã to nhất = nhãn gần camera nhất; giải mã được
= đủ nét. Không cần thuật toán đo độ nét riêng.

**Ở bước ghép, agent làm thêm:**

```
1. offset_nhan = best_frame_at − qr.segments[0].started_at
2. ffmpeg -ss <offset_nhan> -i qr.raw.mp4 -frames:v 1
          -vf "crop=<vùng nhãn>,scale=-2:540" nhan.png
3. Đưa nhan.png vào filter graph như một đầu vào ảnh tĩnh lặp lại
```

- Lấy khung từ **luồng chính** đã ghi (1080p), không từ khung xám 720p dùng để giải
  mã — rõ hơn nhiều, có màu.
- **Vùng nhãn** = `qr_box` quy đổi từ toạ độ luồng phụ sang luồng chính (nhân tỉ lệ
  kích thước), rồi **nới rộng** ra quanh mã QR để lấy phần chữ của nhãn. ⚠️ Kiểm luồng
  phụ và luồng chính của model Dahua có **cùng góc nhìn** không (thường có, nhưng một
  số model luồng phụ bị cắt khác tỉ lệ).
- Tỉ lệ nới rộng theo bố cục nhãn SPX thật — đo ở mốc M0.

**Độ rõ của chữ trên nhãn** (🟡): chữ trên nhãn vận đơn cao khoảng 2–3 mm. Người đọc
được cần 🟡 ≥ 3–4 điểm ảnh/mm.

| Nguồn ảnh nhãn | Vùng quét 30 cm | Đọc được chữ? |
|---|---|---|
| Luồng phụ 1280 px | ~4,3 px/mm | Vừa đủ |
| **Luồng chính 1920 px** | **~6,4 px/mm** | **Tốt** |
| Pane video 960 px trong bản ghép | ~3,2 px/mm | **Sát ngưỡng — chữ nhỏ khó đọc** |

→ Đây là lý do **không nên chỉ dựa vào pane video Dahua thu nhỏ** để đọc thông tin
đơn. Ảnh nhãn cắt riêng từ luồng chính, phóng vừa khung, rõ hơn nhiều.

**Bố cục đề xuất mới** (thay bố cục ở 5.6, cùng khung 1920×720):

```
┌───────────────────────────────┬───────────────────────────────┐
│                               │  ẢNH NHÃN (tĩnh, cả video)    │
│   HIKVISION — TOÀN CẢNH       │  cắt quanh mã QR, từ luồng    │
│   video trực tiếp             │  chính Dahua                  │
│   960×540                     │                  ┌──────────┐ │
│                               │                  │ Dahua    │ │
│                               │                  │ trực tiếp│ │
│                               │                  │ 320×180  │ │
│                               │                  └──────────┘ │
├───────────────────────────────┴───────────────────────────────┤
│ SPXVN066995638828 · Kho Đại Kim · BAN01 · NV012                │
│ Nhãn quét lúc 14:03:11 · Đóng đơn 2 phút 45 giây   14:04:02 ◄──│ đồng hồ chạy
└───────────────────────────────────────────────────────────────┘
```

- Nửa trái: Hikvision chạy suốt clip — chứng minh **hành động đóng gói**.
- Nửa phải: ảnh nhãn tĩnh — chứng minh **đơn nào**, đọc được mọi lúc.
- Ô nhỏ Dahua trực tiếp ở góc: vẫn thấy **khoảnh khắc giơ nhãn thật** ở đầu clip, để
  người xem đối chiếu ảnh tĩnh với video gốc — ảnh tĩnh không phải thứ "dựng lên".

**Dự phòng khi không có ảnh nhãn** (`best_frame_at` thiếu — dữ liệu cũ, hoặc đơn tạo
bằng nhập tay/súng quét dự phòng): nửa phải quay về video Dahua trực tiếp như bố cục
5.6.

**Chi phí CPU:** thêm một lần trích 1 khung (vài chục ms) và một lớp overlay ảnh tĩnh
— 🟡 không đáng kể so với mã hoá. Ô Dahua 320×180 **nhẹ hơn** pane 960×540 cũ, nên
tổng chi phí ghép **giảm nhẹ**.

#### 13.10.6 Tham số cập nhật

| Tham số | Giá trị | Ghi chú |
|---|---|---|
| `QR_DECODE_FPS` | 10 | Tăng từ 5 |
| `QR_CONFIRM_FRAMES` | 2 | Giảm từ 3 |
| `QR_ZONE_CLEAR_MS` | 1500 | Giữ — vẫn cần cho tay che nhãn lúc đang giơ |
| `QR_SAME_CODE_SUPPRESS_MS` | 60000 | Giữ — nhân viên không thấy 🟢 sẽ giơ lại cùng nhãn; màn hình nên báo "đã nhận trước đó" |
| `QR_PRESENCE_DIFF_THRESHOLD` | 🟡 chỉnh hiện trường | Mới — ngưỡng "có vật trong vùng" |
| `QR_MISSED_PRESENTATION_MS` | 500 | Mới — có vật ≥ 0,5 giây mà không đọc được mã thì đếm một lần trượt |
| `COMPOSE_LAYOUT` | `wide_plus_label` | Mới — `wide_plus_label` (đề xuất) \| `side_by_side` (dự phòng) |

#### 13.10.7 Tiêu chí nghiệm thu bổ sung

| Chỉ số | 🟡 Ngưỡng |
|---|---|
| Giơ nhãn bị trượt (có vật, không đọc được mã) | ≤ 0,5% số lần giơ |
| Thời gian từ lúc nhãn đứng yên tới màn hình 🟢, p95 | ≤ 1,5 giây |
| Ảnh nhãn trong video ghép đọc được mã vận đơn **bằng mắt** | 100% trên mẫu kiểm tay 50 clip |
| Ảnh nhãn đọc được tên người nhận/thông tin đơn bằng mắt | ≥ 95% trên cùng mẫu |

#### 13.10.8 Quyết định thêm cần chốt

| # | Câu hỏi | Ảnh hưởng tới |
|---|---|---|
| 15 | Có làm **tấm đỡ/khung trình nhãn** cố định tại vùng quét không? | Độ nét, tỉ lệ đọc trượt |
| 16 | Bố cục video ghép: **toàn cảnh + ảnh nhãn tĩnh** (đề xuất) hay **chia đôi 2 video**? | Giá trị bằng chứng, độ rõ thông tin đơn |
| 17 | Ảnh nhãn in **tên + địa chỉ người nhận** lên video gửi khách có chấp nhận được không? | Dữ liệu cá nhân — có thể cần che/làm mờ một phần nhãn |

### 13.11 CHỐT: Hikvision toàn khung + Dahua ô nhỏ + giờ in sẵn của camera + thông báo khi quét

Mục này **ghi đè**: bố cục ở 5.6 và 13.10.5, dòng OSD ở 2.2 và 13.4, phần phản hồi ở
4.6 và 13.7.

**Quyết định đã chốt:**

1. **Không chia đôi màn hình.** Video Hikvision chiếm toàn khung, video Dahua ghép
   vào **một góc nhỏ** (picture-in-picture).
2. **Dùng đồng hồ in sẵn trên hình của cả 2 camera** (OSD) làm mốc thời gian cho người
   xem. Bỏ đồng hồ chạy do agent tự vẽ.
3. **Thông báo khi quét được QR** để nhân viên biết lúc lấy nhãn ra.

#### 13.11.1 Bố cục

```
┌──────────────────────────────────────────────────────────────────┐
│ 13/09/2026 14:03:12  ← OSD Hikvision          ┌────────────────┐ │
│                                               │13/09 14:03:12  │ │
│                                               │ ← OSD Dahua    │ │
│                                               │  DAHUA — QUÉT  │ │
│          HIKVISION — TOÀN CẢNH                │  640×360       │ │
│          1920×1080, video trực tiếp           └────────────────┘ │
│                                                                  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ SPXVN066995638828 · Kho Đại Kim · BAN01 · NV012 · Đóng đơn 2p45s │
└──────────────────────────────────────────────────────────────────┘
```

| Thành phần | Vị trí | Vì sao |
|---|---|---|
| Hikvision | Toàn khung 1920×1080 | Chứng minh hành động đóng gói, giữ tối đa chi tiết |
| Dahua | **Góc trên bên phải**, 640×360 (⅓ bề ngang), viền mảnh | Tránh đè OSD giờ của Hikvision (đặt ở góc trên trái) và thanh thông tin (ở dưới) |
| Thanh thông tin đơn | Dải dưới cùng, nền đen mờ | 🔵 Yêu cầu R6: đủ thông tin như panel dashboard (mã vận đơn, kho, bàn, nhân viên, thời gian đóng đơn). **Không có đồng hồ chạy** — OSD camera lo phần đó |

**Filter graph:**

```
ffmpeg -hide_banner -loglevel error -y -progress pipe:1 -nostats
  -ss <offset_hik>   -t <duration> -i hik.raw.mp4
  -ss <offset_dahua> -t <duration> -i dahua.raw.mp4
  -filter_complex_script compose.txt
  -map "[v]" -an -c:v <bộ mã hoá> -pix_fmt yuv420p -g 50
  -b:v <bitrate> -maxrate <1.2×> -bufsize <2×> -movflags +faststart
  {pe}.{cmd}.tmp.mp4
```

`compose.txt`:

```
[0:v]fps=25,scale=1920:1080:force_original_aspect_ratio=decrease,
     pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[base];
[1:v]fps=25,scale=640:360:force_original_aspect_ratio=decrease,
     pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,
     pad=iw+6:ih+6:3:3:color=white[pip];
[base][pip]overlay=x=W-w-24:y=24:eof_action=pass[v0];
[v0]drawbox=x=0:y=ih-72:w=iw:h=72:color=black@0.55:t=fill,
    drawtext=fontfile='fonts/NotoSans-Bold.ttf':textfile='info.txt':
             fontsize=32:fontcolor=white:x=24:y=h-54[v]
```

- `eof_action=pass`: góc Dahua hết video sớm (thiếu segment cuối) thì khung Hikvision
  **vẫn chạy tiếp**, ô nhỏ biến mất thay vì làm dừng cả video.
- Không có góc Dahua (camera hỏng / segment hết hạn) → bỏ nhánh `[1:v]`, thanh thông
  tin thêm dòng **"KHÔNG CÓ VIDEO GÓC QUÉT MÃ"** (mục 5.3).
- Đầu ra 1920×1080 tốn mã hoá hơn bản 1920×720 🟡 ~50%. Nếu máy kho **không có bộ mã
  hoá phần cứng** và thời gian ghép vượt tiêu chí, hạ đầu ra xuống 1280×720 (ô Dahua
  426×240).

#### 13.11.2 ⚠️ Mối lo: ô 640×360 không đọc được chữ trên nhãn

Nói một lần cho rõ, rồi để bạn quyết.

🟡 Vùng quét 30 cm thu vào ô 640 px ≈ **2,1 điểm ảnh/mm**. Chữ trên nhãn cao 2–3 mm →
**4–6 điểm ảnh — không đọc được bằng mắt**. Mã QR vẫn nhìn thấy, OSD giờ của Dahua
vẫn thấy (nếu chỉnh cỡ chữ lớn — 13.11.3), nhưng **tên người nhận, nội dung đơn trên
nhãn thì không**.

Nếu mục đích của góc Dahua chỉ là chứng minh **"đã giơ nhãn nào, lúc mấy giờ"** — mã
vận đơn đã có ở thanh thông tin, giờ đã có ở OSD — thì **ô nhỏ là đủ**, bỏ qua mục
này.

Nếu vẫn cần **đọc được nội dung nhãn trên video**, có hai cách rẻ, không đổi bố cục:

| Cách | Làm | Chi phí |
|---|---|---|
| **A. Phóng to ô Dahua lúc giơ nhãn** | Từ `scanned_at − 1 giây` tới `scanned_at + 4 giây`, ô Dahua hiện **960×540**; ngoài khoảng đó thu về 640×360. Dùng 2 bản scale + `overlay=...:enable='between(t,a,b)'` | 🟡 Không đáng kể. Người xem thấy rõ nhãn đúng lúc giơ |
| B. Ảnh nhãn tĩnh | Như 13.10.5 | Phức tạp hơn, phải cắt vùng nhãn |

Khuyến nghị: **Cách A** nếu cần; nó giữ đúng tinh thần "chỉ ghép video" mà vẫn đọc
được nhãn. Cần `best_frame_at` hoặc `scanned_at` — cả hai đều đã có.

#### 13.11.3 Dùng OSD của camera làm đồng hồ — điều kiện bắt buộc

**Được lợi:**
- Giờ **nướng sẵn vào từng khung lúc camera chụp** — không phụ thuộc agent tính đúng.
- Người xem **tự đối chiếu** 2 góc: hai đồng hồ cùng hiện một giờ = hai góc khớp.
- Bỏ được việc tự vẽ đồng hồ chạy — filter graph đơn giản hơn, không phải lo chuỗi
  thời gian thoát ký tự trong `drawtext`.
- **Hiệu chỉnh lệch 2 góc dễ hơn hẳn** (13.11.4).

**Nhưng giờ OSD giờ là một phần của bằng chứng, nên sai là mâu thuẫn trên video:**

🔵 Mốc thời gian của hệ thống (`scanned_at`, `started_at` của segment, "Video bắt đầu /
kết thúc" trên dashboard) lấy theo **đồng hồ máy kho**. OSD lấy theo **đồng hồ của
từng camera**. Ba đồng hồ này độc lập. Camera IP không đồng bộ NTP 🟡 thường trôi vài
giây mỗi ngày, vài phút sau vài tháng.

Hậu quả nếu lệch: dashboard ghi "Nhãn quét lúc 14:03:12", video Hikvision hiện
14:03:40, ô Dahua hiện 14:02:55. **Khách khiếu nại chỉ cần chỉ vào chỗ đó.**

**Bắt buộc cấu hình:**

| Thiết lập | Hikvision | Dahua |
|---|---|---|
| **NTP** | Configuration → System → System Settings → Time Settings → NTP | Setting → System → General → Date & Time → NTP |
| **Máy chủ NTP** | **Cùng máy chủ với máy kho** (router nội bộ, hoặc chính máy kho bật NTP server) | Cùng |
| Chu kỳ đồng bộ | Ngắn nhất cho phép (🟡 5–60 phút) | Cùng |
| Múi giờ | GMT+07:00, **tắt giờ mùa hè (DST)** | Cùng |
| Định dạng giờ | 24 giờ, `DD/MM/YYYY HH:MM:SS` | Cùng |
| Vị trí OSD giờ | **Góc trên bên trái** | Góc trên bên trái |
| **Cỡ chữ OSD** | Mặc định | **Lớn nhất** — ô Dahua thu nhỏ ⅓, chữ mặc định sẽ không đọc được |
| Tên kênh / tên camera trên hình | Tắt, hoặc để góc dưới | Tắt (thanh thông tin đã có) |

⚠️ Tên mục khác nhau theo đời firmware — dò trên máy thật.

**🟡 Theo dõi lệch giờ camera (đề xuất bổ sung):** chuẩn ONVIF có lệnh
`GetSystemDateAndTime` đọc giờ của camera, và theo chuẩn **thường không yêu cầu đăng
nhập**. 🔵 Agent đã có mã ONVIF (`lan-onvif.ts`, dùng cho quét tìm camera). Agent có
thể đọc giờ 2 camera mỗi ~10 phút, so với giờ máy, gửi qua heartbeat → thêm một mục
tự kiểm "giờ camera lệch > 2 giây". ⚠️ Kiểm model thật có trả lệnh này không cần đăng
nhập.

🔵 Dự án đã làm y hệt việc này cho máy kho: heartbeat gửi `time_drift_seconds`, dashboard
cảnh báo khi lệch > 30 giây. Camera giờ cũng cần, với ngưỡng chặt hơn.

#### 13.11.4 Hiệu chỉnh lệch 2 góc bằng chính OSD

Không cần đồng hồ mili-giây bên ngoài như đề xuất ở 13.5.

1. Ghép thử một clip 10 phút ở bàn cần hiệu chỉnh.
2. Mở video, tua **từng khung** (phím `.` trong VLC / `→` trong trình phát khung) quanh
   một lần OSD Hikvision **nhảy giây**, ví dụ từ `:12` sang `:13`. Ghi số khung.
3. Tìm khung mà OSD Dahua nhảy **cùng giây đó**. Ghi số khung.
4. Chênh lệch số khung × 40 ms (ở 25 khung/giây) = `qr_offset_ms`.
5. Lặp lại ở **phút 5 và phút 10** → nếu chênh lệch khác nhau > 200 ms là **có trôi**
   (13.5 — rủi ro DTS của Dahua).

Độ chính xác: **±40 ms**, dù OSD chỉ hiện tới giây — vì bắt đúng khung chuyển giây.

⚠️ Phép đo này **chỉ đúng khi 2 camera đã đồng bộ NTP**. Nếu chưa, chênh lệch đo được
là tổng của lệch luồng + lệch đồng hồ camera, và sẽ đổi dần theo ngày.

#### 13.11.5 Thông báo khi quét được QR

**Yêu cầu:** nhân viên thấy thông báo ngay khi Dahua đọc được mã, để biết lúc lấy nhãn
ra.

**Ràng buộc:**

- 🔵 Agent chạy dạng Windows service → không phát âm thanh, không hiện cửa sổ lên màn
  hình người dùng (Session 0).
- **Phải chạy được cả khi kho mất Internet.** 🔵 Agent đã xếp hàng sự kiện quét khi
  mất mạng (`queue.ts`). Nếu thông báo đi qua cloud, mất mạng là **mất thông báo** →
  nhân viên không biết đã quét chưa → quy trình "giữ tới khi có thông báo" gãy đúng
  lúc khó khăn nhất.

**Thiết kế đề xuất: agent tự phục vụ một trang thông báo trong mạng nội bộ.**

```
Dahua ─► agent: đọc được mã X
            │
            ├──► (1) PHÁT NGAY lên trang thông báo nội bộ     ← ~0,3–0,75 giây, không cần Internet
            │         🟢 "ĐÃ NHẬN — lấy nhãn ra"  + tiếng báo
            │
            └──► (2) gửi /api/warehouse/scans như súng quét    ← có thể chậm / xếp hàng
                      │
                      ▼ response
                 (3) CẬP NHẬT trang theo kết quả của cloud
                      🟢 "Đơn mới đã bắt đầu"          packing_result.status = valid
                      🟠 "Chưa mở ca — quét QR nhân viên" status = no_active_session
                      🟠 "Mã đã quét hôm nay"          status = duplicated
                      🟠 "Bàn chưa gán thiết bị quét"  status = unmapped_scanner
                      ⚪ "Đã nhận, đang chờ gửi"        mất mạng, đã xếp hàng
```

🔵 Bước (3) dùng được ngay: route `/api/warehouse/scans` đã trả `packing_result`,
`session_action`, `warning`, và agent **đã đọc sẵn** các trường này (`index.ts`, hiện
chỉ in ra log).

**Hai tầng thông báo này có giá trị riêng:** súng quét chỉ cho biết "đã đọc mã". Trang
này còn cho biết **"hệ thống có tạo đơn không"** — nhân viên quét khi chưa mở ca sẽ
biết ngay, thay vì tới cuối ngày mới phát hiện đơn không có ai đóng.

**Cách làm ở agent:**

| Hạng mục | Chi tiết |
|---|---|
| Thư viện | `node:http` có sẵn trong Node — **không thêm dependency**. 🔵 Agent hiện chưa có HTTP server nào |
| Cơ chế đẩy | **Server-Sent Events (SSE)** — trình duyệt giữ một kết nối, agent đẩy sự kiện xuống. Nhẹ hơn WebSocket, không cần thư viện, tự nối lại |
| Địa chỉ | `http://<IP máy kho>:<cổng>/ban/<station_code>` — mỗi bàn một trang |
| Nội dung trang | HTML + JS nhúng sẵn trong agent, không tải gì từ Internet |
| Trạng thái vùng | 🟢 Đã nhận · 🟠 Nhận nhưng có vấn đề · ⚪ Sẵn sàng · 🟡 "Có vật trong vùng nhưng chưa đọc được mã — giữ yên" (sau 1,5 giây, từ 13.10.4) · 🔵 "Mã này vừa nhận rồi" (khi bị chặn đọc lặp) |
| Tự về trạng thái chờ | Sau 3–4 giây |
| File mới | `warehouse-agent/src/station-notifier.ts` (server + SSE), `station-page.html` (nhúng qua `pkg.assets`) |

**Bốn điều phải lo ở hiện trường:**

1. **Tường lửa Windows.** 🔵 Installer hiện **không** tạo rule tường lửa
   (`installer/betacom-agent.iss`). Phải thêm rule mở cổng inbound cho agent, chỉ ở
   profile mạng Private/Domain.
2. **Trình duyệt chặn tự phát âm thanh.** Chrome/Edge không cho trang phát tiếng khi
   người dùng chưa bấm gì. Hai cách: nút **"Bật âm thanh"** bấm một lần đầu ca; hoặc
   máy tại bàn mở trình duyệt chế độ kiosk với cờ
   `--autoplay-policy=no-user-gesture-required`.
3. **Bảo mật.** Trang chỉ đọc, chỉ phục vụ trong LAN, không chứa secret. Chỉ hiện mã
   vận đơn + trạng thái — **không hiện tên người nhận**. Thêm mã ngắn theo bàn trong
   URL để người ngoài bàn không mở nhầm.
4. **Màn hình tại bàn.** Máy tính bảng, điện thoại cũ, hoặc màn hình phụ nối máy kho —
   chỉ cần trình duyệt và cùng mạng Wi-Fi/LAN với máy kho.

**Không có màn hình tại bàn thì sao:** thay bằng **đèn/còi báo qua mạng** (rơ-le IP):
agent gọi HTTP tới rơ-le, đèn xanh sáng 2 giây. Mất tầng thông báo (3), chỉ còn "đã
đọc mã". Hoặc ⚠️ dùng **ngõ ra báo động / loa của chính camera Dahua** nếu model có —
gọi qua API HTTP của Dahua; phụ thuộc model.

#### 13.11.6 Việc bỏ đi so với các phiên bản kế hoạch trước

| Bỏ | Lý do |
|---|---|
| Bố cục chia đôi (5.6) | Đã chốt picture-in-picture |
| Ảnh nhãn tĩnh (13.10.5) | Không cần — nếu cần đọc nhãn, dùng Cách A (13.11.2) |
| Đồng hồ chạy do agent vẽ | OSD camera thay thế |
| Tắt OSD camera (2.2, 13.4) | Ngược lại: **bật OSD + NTP bắt buộc** |
| Phép thử đồng hồ mili-giây bên ngoài (13.5) | Thay bằng đo khung chuyển giây của OSD (13.11.4) |
| Phản hồi qua trang cloud (4.6, 13.7) | Thay bằng trang nội bộ do agent phục vụ — chạy được khi mất Internet |

#### 13.11.7 Thêm vào danh sách thay đổi code

| Phía | File | Việc |
|---|---|---|
| Agent | `station-notifier.ts` (mới) | HTTP + SSE, phát sự kiện 2 tầng |
| Agent | `station-page.html` (mới, nhúng `pkg.assets`) | Trang thông báo, âm thanh, tự về trạng thái chờ |
| Agent | `compose-plan.ts` | Bố cục PiP; Cách A nếu bật; không vẽ đồng hồ |
| Agent | `index.ts` luồng gửi quét | Sau khi có response, đẩy tầng (3) sang `station-notifier` |
| Agent | `camera-time-check.ts` (mới, nên có) | Đọc giờ camera qua ONVIF, gửi qua heartbeat |
| Agent | `config.ts` | `STATION_NOTIFIER_PORT`, `COMPOSE_LAYOUT=pip`, `COMPOSE_PIP_ZOOM_ON_SCAN=false` |
| Installer | `betacom-agent.iss` | Rule tường lửa inbound cho cổng thông báo |
| Cloud | `heartbeat/route.ts` + `system/checks.ts` | Nhận và cảnh báo lệch giờ camera |

#### 13.11.8 Tiêu chí nghiệm thu bổ sung

| Chỉ số | 🟡 Ngưỡng |
|---|---|
| Từ lúc nhãn đứng yên tới thông báo 🟢, p95 | **≤ 1 giây** (không còn phụ thuộc cloud) |
| Thông báo vẫn hiện khi rút cáp Internet máy kho | Có |
| Lệch giờ OSD Hikvision ↔ Dahua ↔ máy kho | ≤ 1 giây, liên tục 7 ngày |
| OSD giờ trong ô Dahua đọc được bằng mắt trên video ghép | 100% |
| Lệch 2 góc đầu clip và cuối clip 10 phút | Chênh nhau ≤ 200 ms |

#### 13.11.9 Quyết định thêm cần chốt

| # | Câu hỏi | Ảnh hưởng tới |
|---|---|---|
| 18 | Góc Dahua có cần **đọc được nội dung nhãn** trên video không, hay chỉ cần thấy mã + giờ? | Có bật Cách A (phóng to ô lúc giơ nhãn) không |
| 19 | Máy chủ NTP chung cho máy kho + 2 camera là gì — router, máy kho, hay máy chủ ngoài? | Độ tin cậy của OSD làm bằng chứng |
| 20 | Mỗi bàn có **màn hình** cho trang thông báo không? Nếu không: đèn báo qua mạng hay loa camera? | Phần cứng mỗi bàn |

### 13.12 CHỐT: toàn bộ chữ trên nhãn phải đọc rõ trong video bằng chứng

Mục này **ghi đè**: kích thước vùng quét ở 13.6, bố cục ô nhỏ cố định ở 13.11.1, lưu ý
13.11.2, phương án hạ đầu ra xuống 1280×720 ở 13.11.1.

**Yêu cầu R8:** mọi chữ trên nhãn vận đơn — mã vận đơn, tên, số điện thoại, địa chỉ
người nhận, nội dung đơn — **đọc được bằng mắt trong video đã ghép gửi khách**.

**Lý do:** Hikvision quay toàn cảnh nên không đọc được chữ trên nhãn. Nếu Dahua cũng
không đọc được thì góc Dahua chỉ tương đương máy quét QR, và video **không chứng minh
được đang đóng đúng đơn đó**.

Chữ trên nhãn có thể mất độ rõ ở **ba chỗ**, phải giữ được ở cả ba:

```
 (1) CAMERA CHỤP          (2) GHÉP VIDEO             (3) NÉN H.264 KHI GHÉP
 đủ điểm ảnh trên chữ?    có thu nhỏ chữ không?     bitrate có làm nhoè chữ không?
        │                        │                          │
        └────────────── thiếu ở bất kỳ chỗ nào là chữ không đọc được ──────┘
```

#### 13.12.1 Tầng (1) — Dahua phải chụp đủ nét

**Chỉ tiêu:** chữ nhỏ nhất trên nhãn cần 🟡 **≥ 6 điểm ảnh/mm** tại camera (chữ cao
1,5 mm ≈ 9 điểm ảnh). Dưới 4 điểm ảnh/mm là không đọc được sau khi nén.

⚠️ **Giả định kích thước nhãn SPX ~100 × 150 mm, chữ nhỏ nhất ~1,5 mm.** Đo nhãn thật
ở mốc M0 — mọi con số dưới đây tỉ lệ theo đó.

**Hướng giơ nhãn quyết định mọi thứ.** Khung hình camera là 16:9 (nằm ngang):

| Hướng nhãn | Vùng nhìn cần (có lề) | Mật độ ở 1080p (1920 px) | Ở 4MP (2560 px) | Ở 8MP (3840 px) |
|---|---|---|---|---|
| **Nằm ngang** (cạnh 150 mm nằm ngang) | **~22 × 12,5 cm** | **~8,7 px/mm** ✅ | ~11,6 px/mm ✅ | ~17,5 px/mm ✅ |
| Dựng đứng (cạnh 150 mm dựng đứng) | ~34 × 19 cm | ~5,7 px/mm ⚠️ sát ngưỡng | ~7,6 px/mm ✅ | ~11,4 px/mm ✅ |

→ **Quy tắc thao tác: giơ nhãn nằm ngang.** Nhãn nằm ngang khớp khung 16:9, gấp
~1,5 lần mật độ điểm ảnh so với dựng đứng, ở cùng camera.

**Vùng quét thu hẹp lại** so với 13.6: không còn là "30–38 cm để đọc QR", mà **~22 ×
12,5 cm để đọc chữ**. Mã QR ở vùng này dư sức giải mã (QR 3 cm ≈ 170 điểm ảnh trên
luồng phụ 720p).

**Cấu hình camera Dahua:**

| Thiết lập | Giá trị | Vì sao |
|---|---|---|
| Độ phân giải cảm biến | **4MP trở lên** (1080p chỉ đủ khi giơ nhãn nằm ngang và vùng nhìn đúng 22 cm) | Dư biên cho lấy nét lệch, nhãn đặt lệch, nén |
| Luồng chính | Độ phân giải cao nhất, H.264 | Đây là luồng dùng làm bằng chứng |
| **Kiểu bitrate** | **VBR, chất lượng cao nhất, trần 🟡 6–8 Mbps** | CBR thấp làm nhoè chữ ngay từ camera. VBR thì vùng trống (~95% thời gian) tự hạ bitrate → **ổ đĩa không tăng tương xứng** |
| Smart Codec | Tắt | Như 13.4 |
| Lấy nét | **Thủ công**, chỉnh đúng mặt phẳng của tấm đỡ nhãn | Camera IP tự lấy nét chậm và hay "săn nét" khi có vật đưa vào |
| Màn trập | **Thủ công, 1/500–1/1000 giây** | Chống nhoè khi nhãn đang đưa vào |
| Độ khẩu (nếu chỉnh được) | Khép bớt | Tăng độ sâu trường ảnh — nhãn lệch vài cm vẫn nét |
| Luồng phụ | 720p | Cho giải mã QR (13.4) |

**Tấm đỡ / khung trình nhãn — chuyển từ "nên có" (13.10.3) sang BẮT BUỘC:**
- Mặt phẳng cố định ở đúng khoảng cách camera đã lấy nét.
- **Gờ chặn góc** để nhãn luôn nằm ngang và đúng vị trí — vùng nhìn 22 × 12,5 cm
  không có chỗ cho đặt lệch.
- Mặt tấm màu tối, không bóng — chữ đen trên giấy trắng nổi rõ, không loá.

**Ánh sáng:** 🟡 ≥ 500 lux đều trên vùng quét, đèn tán xạ (không rọi điểm). Nhãn in
nhiệt thường mờ bóng, nhưng **màng bọc nilon** phản xạ mạnh — nghiêng camera 5–10° so
với phương vuông góc để tránh vệt loá lọt thẳng vào ống kính.

#### 13.12.2 Tầng (2) — Bố cục: **đổi vai 2 góc lúc giơ nhãn**

Ô nhỏ cố định 640×360 thu chữ xuống ~2,9 px/mm → **không đọc được**. Thay bằng bố
cục đổi vai:

```
 NGOÀI lúc giơ nhãn (phần lớn clip)            TRONG lúc giơ nhãn (vài giây)
┌──────────────────────────────┬─────┐       ┌──────────────────────────────┬─────┐
│ HIKVISION toàn khung          │DAHUA│       │ DAHUA toàn khung              │ HIK │
│ 1920×1080                     │ nhỏ │  ──►  │ 1920×1080 — NHÃN ĐỌC ĐƯỢC     │ nhỏ │
│                               └─────┤       │                               └─────┤
│                                     │  ◄──  │                                     │
├─────────────────────────────────────┤       ├─────────────────────────────────────┤
│ SPXVN… · Kho · Bàn · NV · 2p45s     │       │ SPXVN… · Kho · Bàn · NV · 2p45s     │
└─────────────────────────────────────┘       └─────────────────────────────────────┘
```

| Thời điểm | Toàn khung | Ô nhỏ góc trên phải |
|---|---|---|
| Ngoài khoảng giơ nhãn | Hikvision | Dahua 640×360 |
| **Từ `first_seen_at − 0,5 s` tới `last_seen_at + 1 s`** | **Dahua** | **Hikvision** 640×360 |

**Hai góc luôn cùng hiện** — không lúc nào mất góc nào. Người xem thấy nhãn đọc được
đúng lúc giơ, và vẫn thấy hành động ở góc toàn cảnh cùng lúc.

🟡 Mật độ chữ khi Dahua toàn khung 1920 px, vùng nhìn 22 cm: **~8,7 px/mm** ✅.

**Hệ quả bắt buộc: đầu ra phải là 1920×1080.** Phương án hạ xuống 1280×720 khi máy
chậm (13.11.1) **bị loại**: Dahua toàn khung 1280 px chỉ còn ~5,8 px/mm, sát ngưỡng.
Nghĩa là **bộ mã hoá phần cứng trở thành gần như bắt buộc** (mục 5.7) — hoặc chấp
nhận chờ ghép lâu hơn.

**Dữ liệu agent phải gửi thêm** (vào `device_identity_snapshot`, 🔵 nối tới đơn qua
`packing_events.raw_event_id`, không cần migration):

```jsonc
"first_seen_at": "2026-09-13T07:03:11.080Z",   // khung đầu tiên thấy mã
"last_seen_at":  "2026-09-13T07:03:12.460Z",   // khung cuối cùng thấy mã
"best_frame_at": "2026-09-13T07:03:11.820Z",   // khung mã QR to nhất
```

**Filter graph đổi vai** — `compose.txt`:

```
[0:v]fps=25,split=2[h0][h1];
[1:v]fps=25,split=2[d0][d1];

[h0]scale=1920:1080:force_original_aspect_ratio=decrease,
    pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[hikFull];
[h1]scale=640:360:force_original_aspect_ratio=decrease,
    pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,pad=iw+6:ih+6:3:3:white[hikPip];
[d0]scale=1920:1080:force_original_aspect_ratio=decrease,
    pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[dahFull];
[d1]scale=640:360:force_original_aspect_ratio=decrease,
    pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,pad=iw+6:ih+6:3:3:white[dahPip];

[hikFull][dahFull]overlay=0:0:enable='between(t,<A>,<B>)'[base];
[base][dahPip]overlay=W-w-24:24:enable='not(between(t,<A>,<B>))':eof_action=pass[v1];
[v1][hikPip]overlay=W-w-24:24:enable='between(t,<A>,<B>)'[v2];

[v2]drawbox=x=0:y=ih-72:w=iw:h=72:color=black@0.55:t=fill,
    drawtext=fontfile='fonts/NotoSans-Bold.ttf':textfile='info.txt':
             fontsize=32:fontcolor=white:x=24:y=h-54[v]
```

`<A>` = `first_seen_at − 0,5 s − target_start` (giây), `<B>` = `last_seen_at + 1 s −
target_start`. Tính trong `compose-plan.ts` (hàm thuần, test được).

🟡 Chi phí: thêm 2 nhánh scale → tổng mã hoá tăng khoảng 20–40% so với PiP đơn giản;
giải mã nguồn 4MP tốn hơn 1080p. Giải mã phần cứng (`-hwaccel qsv`) bù phần lớn.

**Tuỳ chọn thêm — cắt sát nhãn thay vì cả khung Dahua:** trong khoảng đổi vai, cắt
quanh vùng nhãn (suy từ `qr_box` + tỉ lệ bố cục nhãn SPX) rồi phóng vừa chiều cao
1080 → mật độ chữ tăng thêm ~1,3–1,5 lần. Làm sau, nếu nghiệm thu cho thấy chữ nhỏ
nhất vẫn khó đọc.

**Ở dashboard:** thêm nút **"Tới lúc quét nhãn"** trong trình phát clip — tua tới
`first_seen_at − clip_started_at`. Người xử lý khiếu nại không phải dò trong video 3
phút.

#### 13.12.3 Tầng (3) — Nén không được làm nhoè chữ

🔵 Kế hoạch trước đặt `-b:v 2500k -maxrate 3000k` (5.9). **Với chữ nhỏ thế là thiếu.**
Lúc đổi vai sang Dahua là một **chuyển cảnh** — bộ mã hoá phải dựng lại toàn khung,
và nếu trần bitrate thấp thì mấy khung đầu tiên (đúng lúc nhãn rõ nhất) bị nhoè.

**Cấu hình nén mới:**

| Tham số | Giá trị 🟡 | Vì sao |
|---|---|---|
| Chế độ | **Chất lượng không đổi + trần đỉnh** (x264: `-crf 22`; QSV: `-global_quality 22`) | Cảnh kho tĩnh tốn ít bit, lúc giơ nhãn được cấp nhiều bit |
| Trần đỉnh | `-maxrate 10M -bufsize 20M` | Đủ cho mấy giây nhãn toàn khung |
| **Keyframe tại lúc đổi vai** | `-force_key_frames <A>,<B>` | Khung đầu tiên của nhãn là keyframe đầy đủ, không phụ thuộc khung trước |
| Định dạng màu | `yuv420p` | Giữ nguyên — chữ đen trên nền trắng nằm ở kênh sáng, không bị ảnh hưởng bởi lấy mẫu màu |

**Dung lượng vẫn nằm dưới trần 90 MiB:** 🟡 clip 3 phút, cảnh kho tĩnh trung bình
~2–3 Mbps ≈ 45–65 MiB; mấy giây nhãn ở 10 Mbps chỉ thêm ~5 MiB. Công thức hạ trần
theo thời lượng (5.9) vẫn giữ để chặn clip dài.

⚠️ Tên tham số chất lượng của `h264_qsv` / `h264_nvenc` khác `libx264` — kiểm trên bản
ffmpeg thật ở mốc M3.

#### 13.12.4 Kiểm tự động: file ghép phải đọc lại được

Không để tới lúc khách khiếu nại mới biết chữ nhoè.

**Sau khi ghép, trước khi đẩy lên Supabase** — thêm bước vào 5.9:

```
1. Trích khung tại best_frame_at từ CHÍNH FILE GHÉP (không phải file Dahua gốc)
2. Chạy lại zxing-wasm trên khung đó
3. Giải mã ra đúng mã vận đơn của đơn  → ĐẠT
   Không giải mã được / ra mã khác      → KHÔNG ĐẠT
```

**Vì sao đây là phép thử hợp lý:** ô vuông nhỏ của mã QR (🟡 ~0,9 mm với mã 3 cm) gần
bằng nét chữ trên nhãn. Nếu sau khi thu phóng và nén mà mã QR còn giải được, thì đường
ống **không phá hỏng chi tiết cỡ đó**. Không đảm bảo 100% chữ nhỏ nhất đọc được — phần
đó kiểm tay ở nghiệm thu — nhưng bắt được mọi lỗi lớn: sai bố cục, sai offset (khung
đổi vai trượt khỏi lúc giơ nhãn), bitrate quá thấp, lấy nét hỏng.

**Không đạt thì:**
1. Ghép lại **một lần** với trần bitrate cao hơn (`-maxrate 16M`).
2. Vẫn không đạt → **vẫn đẩy clip lên** (video đóng gói vẫn có giá trị), ghi
   `generation_params.label_check = "failed"` + lý do.
3. Dashboard hiện cảnh báo **"Nhãn trong clip có thể không đọc rõ"** cạnh video.
4. Đếm vào mục tự kiểm — nhiều clip không đạt ở cùng một bàn = camera lệch nét / bẩn
   ống kính / đèn hỏng.

#### 13.12.5 Thông báo 🟢 chỉ bật khi đã có khung nét

Sửa luật ở 13.10.3 và 13.11.5: 🟢 **không** bật ngay khi đọc được mã, mà khi agent đã
có **đủ khung nét để làm bằng chứng**.

```
Bật 🟢 khi:
  mã QR giải mã được ở ≥ QR_LEGIBLE_FRAMES khung (🟡 3 khung ≈ 0,3 giây ở 10 khung/giây)
  VÀ bề rộng mã trong các khung đó ≥ QR_LEGIBLE_MIN_WIDTH_PX (nhãn đã áp sát tấm đỡ)
```

**Vì sao:** nhân viên lấy nhãn ra ngay khi thấy 🟢. Nếu 🟢 bật từ khung đầu tiên đọc
được (có thể khung nhoè lúc nhãn đang đưa vào), video có thể **không có khung nét nào**.
Gắn 🟢 với điều kiện "đã đủ khung nét" nghĩa là **thao tác của nhân viên tự đảm bảo
chất lượng bằng chứng**.

Sự kiện quét gửi cloud (`scanned_at = first_seen_at`) vẫn phát ngay từ lúc xác nhận mã
— không đợi khung nét. Chỉ thông báo cho nhân viên là đợi.

🟡 Tuỳ chọn thêm: đo độ nét (phương sai Laplacian) trên vùng mã QR của khung xám — tính
trong JS chưa tới 1 ms — thay cho điều kiện bề rộng.

#### 13.12.6 ⚠️ Chuỗi bằng chứng còn một mắt xích hở

Video giờ chứng minh được **"nhãn của đơn X đã được giơ lên lúc 14:03:11"** và **"có
hành động đóng gói lúc đó"**. Nhưng một người muốn bắt bẻ có thể nói: **"các anh giơ
nhãn đơn X lên camera, rồi đóng một thùng hàng khác."**

Để khép chuỗi, Hikvision cần thấy được sự liên kết giữa nhãn và thùng hàng:

| Mắt xích | Ai thấy | Làm gì |
|---|---|---|
| Nhãn nào | Dahua | ✅ Đã có — đọc được toàn bộ chữ |
| Nhãn đó được giơ lên | Hikvision | **Hikvision phải nhìn thấy vùng quét** — chuyển từ "nên" (13.6) sang **bắt buộc** |
| **Nhãn đó được dán lên thùng nào** | Hikvision | **Quy trình: dán nhãn lên thùng ngay sau khi quét, trong khung Hikvision** |
| Hàng gì được bỏ vào thùng đó | Hikvision | Đặt hàng + thùng ở giữa khung, không che bằng người |
| Thùng được niêm phong | Hikvision | Dán băng keo trong khung |

Trình tự thao tác đề xuất cho mỗi đơn:

```
Giơ nhãn nằm ngang lên tấm đỡ → chờ 🟢 → dán nhãn lên thùng (trong khung Hikvision)
→ bỏ hàng vào → niêm phong → đẩy thùng ra → (đơn tiếp theo)
```

Đây là quyết định vận hành, không phải code — nhưng thiếu nó thì video đọc rõ chữ vẫn
có một kẽ hở pháp lý.

#### 13.12.7 Dữ liệu cá nhân

Video giờ hiện rõ **tên, số điện thoại, địa chỉ người nhận**. Nếu video gửi cho **chính
người nhận** đang khiếu nại → đó là thông tin của họ, không vấn đề. Nếu gửi cho **sàn
TMĐT, đơn vị vận chuyển, hay bên thứ ba** → là chia sẻ dữ liệu cá nhân, cần cơ sở
(điều khoản với khách hàng của kho). Không làm mờ — mờ thì mất đúng giá trị bằng
chứng. Ghi vào quy trình xử lý khiếu nại: **ai được nhận video**.

#### 13.12.8 Tài nguyên cập nhật

| Hạng mục | Trước | Sau |
|---|---|---|
| Camera Dahua | 1080p, luồng phụ 720p | **4MP trở lên**, luồng phụ 720p, lấy nét thủ công |
| Ổ đĩa góc Dahua | 🟡 ~22 GB/ngày | 🟡 **~15–30 GB/ngày với VBR** (vùng trống nén rất nhỏ); **~65 GB/ngày nếu để CBR 6 Mbps** — bắt buộc VBR |
| Đầu ra ghép | 1920×1080, cho phép hạ 720p | **1920×1080 cố định** |
| Bộ mã hoá phần cứng | Rất nên có | **Gần như bắt buộc** |
| Thời gian ghép | — | 🟡 +20–40% do 2 nhánh scale và nguồn 4MP |
| Dung lượng clip | ~54 MiB | 🟡 ~45–70 MiB (chất lượng không đổi, cảnh tĩnh nhỏ hơn) |
| Phần cứng mỗi bàn | — | **Tấm đỡ có gờ chặn**, đèn tán xạ ≥ 500 lux |

#### 13.12.9 Tiêu chí nghiệm thu bổ sung

| Chỉ số | 🟡 Ngưỡng |
|---|---|
| Kiểm tự động "file ghép giải mã lại được mã QR" | ≥ 99% clip đạt |
| **Kiểm tay 50 clip: đọc được chữ nhỏ nhất trên nhãn** (địa chỉ, số điện thoại) | **100%** |
| Kiểm tay: đọc được tên + mã vận đơn | 100% |
| Khoảng đổi vai chứa đúng lúc nhãn áp trên tấm đỡ | 100% trên mẫu 50 clip |
| Hikvision thấy nhãn được dán lên thùng | ≥ 95% trên mẫu (đo tuân thủ quy trình) |

#### 13.12.10 Quyết định thêm cần chốt

| # | Câu hỏi | Ảnh hưởng tới |
|---|---|---|
| 21 | Model Dahua cụ thể — **4MP trở lên, lấy nét thủ công, luồng phụ 720p, ≥ 2 kết nối RTSP**? | Tầng (1) |
| 22 | Kích thước nhãn thật và **cỡ chữ nhỏ nhất** trên nhãn SPX? | Vùng nhìn, độ phân giải |
| 23 | Chấp nhận quy trình **dán nhãn lên thùng trong khung Hikvision** không? | Mắt xích hở ở 13.12.6 |
| 24 | Video có nhãn rõ được gửi cho **ai** — chỉ người nhận, hay cả sàn/vận chuyển? | Dữ liệu cá nhân |
