# Tuần tự xử lý bài toán 2 camera — BẢN CHỐT

Tài liệu giải pháp, **không có code**. Mỗi bước ghi: **mục tiêu**, **file/thư mục** (mới hoặc sửa),
**việc cần làm**, **xong khi nào**.

- Lịch sử hỏi đáp và lý do của từng quyết định: [tuan-tu-xu-ly-2-camera-hoi-dap.md](tuan-tu-xu-ly-2-camera-hoi-dap.md)
- Kiến trúc tham chiếu ban đầu: [2camera.md](2camera.md)

**Ký hiệu:** 🔵 đã kiểm trong code hiện tại · 🟡 ước lượng, phải đo · ⚠️ phải xác minh khi làm ·
**[GĐ]** giả định tôi tự chốt vì các câu trả lời chưa nói rõ.

**Thuật ngữ:** "agent" = **warehouse agent**, chương trình Node.js chạy dạng Windows service trên máy
tính tại kho (`warehouse-agent/`). 🔵 Hệ thống **không dùng AI**.

---

## 0. Quyết định đã chốt

### 0.1 Phần cứng và mô hình triển khai

| Chủ đề | Quyết định |
|---|---|
| Camera mỗi bàn | **Đúng 2 camera IP qua LAN**: 1 **toàn cảnh**, 1 **quét QR**. **Chưa chốt hãng** |
| Máy tính | Mỗi bàn **một máy tính bàn**, **agent cài trên máy đó** → một tổ chức có **nhiều agent** |
| Máy bàn tắt/bật | **Tắt cuối ngày**, bật đầu ngày. **Không có UPS** |
| Kích hoạt agent | **Như hiện tại**: admin tạo agent ở `/dashboard/agents`, chép mã agent + secret vào cửa sổ cài đặt. **Thêm: chọn bàn khi tạo agent** |
| Internet kho | Tải lên **10 Mbps**, dùng chung |
| VPS | **Không giới hạn** băng thông; máy chủ chuyển tiếp video đặt **cùng VPS** |
| Camera | Người lắp đặt **bật ONVIF** trên camera một lần. Đồng hồ in trên hình của camera **bật**, đồng bộ NTP |

### 0.2 Thiết lập camera (chỉ admin)

| Chủ đề | Quyết định |
|---|---|
| Ai thiết lập | **Admin**, một lần cho mỗi bàn. **Nhân viên kho không thao tác gì với camera** |
| Vai trò được thiết lập / đổi nguồn | **Chủ sở hữu, Quản trị hệ thống, Quản trị nền tảng Betacom** (khi hỗ trợ) |
| Màn hình | Trang **"Bàn đóng hàng"** |
| Tìm camera | Quét LAN **bằng agent của máy bàn đó** → danh sách **chỉ camera**; camera đã kết nối **ghi rõ đang dùng bởi bàn nào** |
| Kết nối | Admin **chọn IP** → nhập **username + password** → hệ thống **tự nhận luồng video, không cần biết hãng** |
| Sai tài khoản | Báo lỗi ngay, kèm cảnh báo camera có thể tự khoá sau vài lần sai |
| Lưu tài khoản | **Lưu mã hoá**; máy bàn bật là agent tự kết nối lại |
| Camera đang thuộc bàn khác | **Hỏi xác nhận rồi tự chuyển** sang bàn mới; không báo cho bàn cũ; ghi nhật ký |
| Đổi mật khẩu trên camera | Mất kết nối → báo admin → admin nhập lại |
| Áp dụng | **Ngay** khi lưu |

### 0.3 Nguồn đọc mã

| Chủ đề | Quyết định |
|---|---|
| Chọn nguồn | **Theo từng bàn**: **máy quét** hoặc **camera** |
| Nguồn không được chọn | **Vô hiệu hoá**; lần quét vẫn **lưu sự kiện thô như hiện tại** nhưng **không tạo đơn**; màn hình bàn báo **"Nguồn đang tắt"** |
| Trang nhập mã bằng tay `/dashboard/packing/scan` | **Chặn** khi bàn chọn camera |
| Chọn máy quét | **Tắt toàn bộ luồng camera QR** (không đọc mã, không ghi hình) → video **1 góc** |
| QR nhân viên | Xử lý **giống máy quét**: bàn chọn camera thì mở/ra ca bằng cách giơ thẻ trước camera |
| Định dạng mã | **Không lọc** — xử lý mọi mã như hiện tại |
| Đổi nhãn | Nhãn cũ phải vắng **tối thiểu 2 giây** mới nhận nhãn mới |
| Nhiều mã trong vùng | Bỏ khung, **báo "Có 2 mã QR"** |
| Đơn kết thúc | **Khi có mã tiếp theo** (giữ luật hiện tại); trần **180 giây** |
| Đổi nguồn khi có đơn mở | **Không chặn**; **ghi nhật ký** |
| Camera QR mất kết nối > 2 phút | **Báo admin qua Lark + dashboard**; **không** tự chuyển sang máy quét |

### 0.4 Ghi hình theo ca

| Chủ đề | Quyết định |
|---|---|
| Bắt đầu | Khi **nhân viên đầu tiên mở ca** trong ngày |
| Kết thúc | Khi **nhân viên cuối cùng ra ca**, **trễ 60 giây** |
| Mất Internet lúc mở ca | Agent **tự bật ghi ngay khi đọc được QR nhân viên**, không chờ cloud |
| Dừng | **Chỉ khi cloud xác nhận** bàn không còn ca mở |
| Quên ra ca | Hệ thống **tự đóng ca treo** → cũng dừng ghi |
| Đổi người / chuyển bàn | **Không** dừng ghi |
| Sau khi dừng ghi | Camera QR **vẫn đọc mã** (để nhận QR mở ca tiếp theo) |
| Sau ra ca cuối | **Tắt hết**: không ghi, **không xem trực tiếp** |
| Lưu segment | **30 ngày** |

### 0.5 Máy tính tại bàn

| Chủ đề | Quyết định |
|---|---|
| Tài khoản | **Mỗi bàn một tài khoản hệ thống**; trình duyệt **nhớ đăng nhập** |
| Trang trên máy bàn | **Một trang gộp** xem trực tiếp + thông báo; **tự mở toàn màn hình** khi bật máy |
| Thông báo | Chỉ **"Đã nhận"** (có tiếng), **"Có 2 mã QR"**, **"Nguồn đang tắt"** |
| Xem trực tiếp trên máy bàn | Bố cục **giống video xuất**, có **dải thông tin đơn**; camera toàn cảnh **luồng phụ**, camera QR **luồng chính** |
| Mất Internet | Chấp nhận: trang không mở được; camera **vẫn ghi và đọc mã**, sự kiện xếp hàng |

### 0.6 Xem trực tiếp từ xa

| Chủ đề | Quyết định |
|---|---|
| Làm khi nào | **Ngay trong đợt này** |
| Ai xem | **Admin**, qua **cloud chuyển tiếp** |
| Chất lượng | **Luồng phụ** cả 2 camera |
| Giới hạn | Tự ngắt sau **10 phút** không thao tác; tối đa **2 admin** một bàn; **không giới hạn** số bàn |

### 0.7 Video bằng chứng

| Chủ đề | Quyết định |
|---|---|
| Khi nào ghép | **Chỉ khi có yêu cầu** |
| Máy bàn đang tắt lúc có yêu cầu | **Ghi nhận yêu cầu** → máy bàn bật thì **tự ghép** → hiện trạng thái **trên dòng đơn** ở trang "Bằng chứng giao hàng" cho **mọi người có quyền xem clip** |
| Video gốc hết hạn khi đang chờ | Báo **"Không còn video gốc"** |
| Bố cục | **1920×1080**; camera toàn cảnh **toàn khung**; camera QR **toàn bộ khung hình** thu vào **ô 1/9 góc trên phải, đúng ô lưới 3×3**, **viền trắng mảnh, không chữ** |
| Chữ trên nhãn | Chữ nhỏ nhất **3 mm** → ô 1/9 đọc được (🟡 ~9,6 điểm ảnh) |
| Thông tin trên video | **Dải đáy**: mã vận đơn · kho · bàn · `mã nhân viên · họ tên` · thời gian đóng đơn |
| Giờ | **Đồng hồ in sẵn của 2 camera** |
| Âm thanh | Không |
| Thiếu một góc | Ra video góc còn lại + dòng cảnh báo |
| Kiểm nhãn đọc được không đạt | **Vẫn upload** + cảnh báo trên dashboard |
| Lưu trên Supabase | **72 giờ** như cũ |
| Tải về | **Mọi vai trò xem được clip**; tên file `<mã vận đơn>_<ngày>-<giờ>.mp4` |
| Link cho người không có tài khoản | **Chưa làm** |

### 0.8 Giả định tôi tự chốt [GĐ]

| # | Giả định | Lý do |
|---|---|---|
| GĐ1 | "Nhân viên cuối ra ca" = **bàn không còn ca nào đang mở**. Nghỉ trưa mà tất cả ra ca thì dừng ghi, mở ca lại thì ghi tiếp | Hệ thống không biết trước lần ra ca nào là "cuối ngày" |
| GĐ2 | Máy bàn **tắt khi ca vẫn mở** (quên ra ca) → sáng hôm sau agent **hỏi cloud bàn có ca mở không** rồi mới ghi lại; không có thì không ghi | Tránh ghi từ lúc bật máy, trái quyết định "bắt đầu khi mở ca" |
| GĐ3 | "Admin" xem từ xa = **Chủ sở hữu, Quản trị hệ thống, Quản trị nền tảng** — cùng nhóm được thiết lập camera | Thống nhất một nhóm quyền |
| GĐ4 | Tài khoản bàn có vai trò **Nhân viên đóng gói** và được **gắn với đúng một bàn** | Để trang máy bàn biết đang là bàn nào |
| GĐ5 | Cảnh báo camera mất kết nối **chỉ khi máy bàn đang bật** | Máy tắt cuối ngày là bình thường; báo lúc đó là báo giả |
| GĐ6 | Cảnh báo trên dashboard hiện ở **danh sách sự cố trang "Giám sát đóng hàng"** | 🔵 Trang đó đã có danh sách sự cố (`src/lib/warehouse/live/issues.ts`); dashboard chưa có chuông thông báo |
| GĐ7 | Chương trình chuyển luồng video dùng **mediamtx** ở cả máy bàn và VPS | Cùng một phần mềm hai đầu; một file chạy; hỗ trợ RTSP → WebRTC và xác thực qua HTTP |
| GĐ8 | Máy bàn tắt đúng lúc đang ghép clip → yêu cầu **quay lại hàng chờ**, ghép lại khi bật máy | Dùng chung cơ chế hàng chờ yêu cầu |

---

## 1. Kiến trúc tổng thể

```
┌──────────────────────────── MÁY TÍNH BÀN (mỗi bàn một máy) ─────────────────────────────┐
│                                                                                          │
│   Camera TOÀN CẢNH ──┬─ luồng chính ─────────────► ffmpeg GHI segment ─► ổ đĩa máy bàn   │
│                      └─ luồng phụ  ─┐                                                    │
│                                     ▼                                                    │
│   Camera QUÉT QR ────┬─ luồng chính ──────────────► ffmpeg GHI segment ─► ổ đĩa máy bàn  │
│                      ├─ luồng chính ─┐                                                   │
│                      └─ luồng phụ  ──┤                                                   │
│                                      ▼                                                   │
│                          mediamtx (bộ chuyển luồng nội bộ, chỉ 127.0.0.1)                │
│                          │          │                    │                               │
│               bộ đọc QR ◄┘   trình duyệt máy bàn    đẩy lên VPS khi admin xem từ xa      │
│                  │           (xem trực tiếp)              │                              │
│                  ▼                  ▲                     │                              │
│   agent: máy trạng thái vùng quét ──┘ thông báo           │                              │
│          → hàng đợi quét → cloud                          │                              │
└───────────────────────────────────────────────────────────┼──────────────────────────────┘
                     │ HTTPS + HMAC                           │
                     ▼                                        ▼
        ┌──────────── CLOUD (VPS) ──────────────┐   ┌──── VPS: mediamtx chuyển tiếp ────┐
        │ Next.js: dashboard, API, hàng lệnh     │◄─►│ xác thực qua API Next.js          │
        │ Postgres (Supabase)                    │   │ → trình duyệt admin (WebRTC)      │
        └──────────────────┬─────────────────────┘   └───────────────────────────────────┘
                           │ signed URL
                           ▼
                 Supabase Storage (clip ghép, 72 giờ)
```

**Nguyên tắc giữ nguyên từ hệ thống hiện tại:**
- 🔵 **Ghi hình đi thẳng từ camera**, không qua bộ chuyển luồng — bộ chuyển luồng hỏng không làm mất
  bằng chứng.
- 🔵 Cloud không bao giờ kết nối vào LAN kho; mọi việc với camera đi qua **hàng đợi lệnh**.
- 🔵 Mật khẩu camera **mã hoá** khi lưu, agent xin lại qua HTTPS + HMAC, **không ghi xuống ổ máy bàn**.

**Số kết nối RTSP mỗi camera** (camera phải cho phép tối thiểu số này):

| Camera | Kết nối | Tối đa đồng thời |
|---|---|---|
| Toàn cảnh | Ghi hình (luồng chính) + luồng phụ cho xem trực tiếp khi có người xem | **2** |
| Quét QR | Ghi hình (luồng chính) + luồng chính cho xem trên máy bàn + luồng phụ cho đọc mã và xem từ xa | **3** |

---

## 2. Rủi ro đã được chấp nhận

| Rủi ro | Từ quyết định | Hậu quả khi xảy ra |
|---|---|---|
| Mã QR khác (ví dụ trên bao bì sản phẩm) lọt vào vùng quét | Không lọc định dạng mã | **Tạo đơn rác và đóng sớm đơn đang đóng gói → clip cụt**. Chỉ chặn được bằng quy định vận hành |
| Mất điện đột ngột | Không UPS | Mất vài giây video cuối, segment cuối có thể hỏng |
| Máy bàn tắt | Tắt cuối ngày | Yêu cầu video phải chờ máy bàn bật; ngoài ca không có video |
| Mất Internet | — | Không xem trực tiếp, không thấy thông báo trên màn hình bàn |
| Nhiều bàn cùng xem từ xa | Không giới hạn số bàn | 🟡 Mỗi bàn ~1–2 Mbps trên đường 10 Mbps dùng chung; khoảng **5 bàn trở lên xem cùng lúc** sẽ tranh băng thông với việc đẩy clip lên Supabase → clip lên chậm, hình xem từ xa giật |
| Admin nhập sai mật khẩu nhiều lần | — | Camera có thể tự khoá tài khoản một thời gian |

---

## 3. Thứ tự các giai đoạn

```
GIAI ĐOẠN A — NỀN MÓNG
  Bước 0   Chuẩn bị, khảo sát
  Bước 1   Database
  Bước 2   Nhiều agent trong một tổ chức
  Bước 3   Gắn agent với bàn, tài khoản với bàn

GIAI ĐOẠN B — THIẾT LẬP CAMERA
  Bước 4   Agent: tìm và kết nối camera không cần biết hãng
  Bước 5   Cloud API: thiết lập camera, nguồn đọc mã
  Bước 6   Cloud UI: trang "Bàn đóng hàng"
  Bước 7   Cloud → agent: cấu hình của bàn

GIAI ĐOẠN C — ĐỌC MÃ + GHI HÌNH THEO CA + XEM TRỰC TIẾP     (đọc mã làm trước)
  Bước 8   Agent: bộ chuyển luồng nội bộ (mediamtx)
  Bước 9   Agent + cloud: ghi hình theo ca
  Bước 10  Agent: đọc mã QR
  Bước 11  Trang máy bàn: xem trực tiếp + thông báo
  Bước 12  Xem trực tiếp từ xa qua VPS

GIAI ĐOẠN D — VIDEO BẰNG CHỨNG                                (làm ngay sau C)
  Bước 13  Cloud: yêu cầu video + hàng chờ khi máy bàn tắt
  Bước 14  Cloud: xác định đoạn video cho 2 camera
  Bước 15  Agent: cắt 2 video, ghép 1 video
  Bước 16  Tiến độ + gia hạn lệnh          ← phát hành CÙNG Bước 15
  Bước 17  Upload, xem, tải về

GIAI ĐOẠN E — VẬN HÀNH
  Bước 18  Cảnh báo, giám sát
  Bước 19  Kiểm thử, đóng gói, chạy thử
```

---

# GIAI ĐOẠN A — NỀN MÓNG

## Bước 0 — Chuẩn bị, khảo sát

**Mục tiêu:** dọn repo và có số liệu thật trước khi viết code.

| Việc | Chi tiết |
|---|---|
| Commit thay đổi đang dở | 🔵 `warehouse-agent/src/index.ts` có thay đổi chưa commit ở vòng kiểm camera (đã chốt **giữ**). Commit riêng, có mô tả. **Bắt buộc** cho kế hoạch: agent trên máy bàn khởi động khi chưa có camera nào |
| Bỏ thư mục bản cài khỏi git | 🔵 `BetacomAgent/` chưa được git bỏ qua, chứa `ffmpeg.exe`, `ffprobe.exe` (~446 MB) và `.env` có secret. Thêm vào `.gitignore` |
| Kiểm camera dự kiến mua | Bật được **ONVIF**; luồng chính và **luồng phụ H.264** (trình duyệt không phát được H.265 qua WebRTC); cho **≥ 3 kết nối RTSP** (camera QR) và **≥ 2** (toàn cảnh); đặt được **NTP**; **đồng hồ in trên hình** |
| Cấu hình camera | GOP = số khung/giây; **tắt smart codec**; camera QR **màn trập thủ công ≤ 1/500 giây**; đồng hồ trên hình bật + NTP chung máy bàn; camera QR chữ đồng hồ **cỡ lớn nhất** (bị thu nhỏ còn 1/3 trong ô 1/9) |
| Gá camera QR | Vùng nhìn **không rộng quá ~20 cm** (vừa nhãn) — rộng hơn thì chữ 3 mm không còn đọc được trong ô 1/9 |
| Máy tính bàn | CPU Intel có **GPU tích hợp** (mã hoá phần cứng khi ghép); RAM ≥ 8 GB; 🟡 ổ **≥ 1 TB** (2 camera ~10 giờ/ngày ≈ 18 GB/ngày × 30 ngày) |
| Trình duyệt máy bàn | ⚠️ Kiểm phiên bản Chrome/Edge có hỏi quyền **"truy cập mạng cục bộ"** khi trang HTTPS gọi `127.0.0.1` không; nếu có, cấp sẵn bằng chính sách trình duyệt |

**Xong khi:** repo sạch; có bảng thông số camera + máy bàn đạt yêu cầu.

---

## Bước 1 — Database

**Thư mục:** `supabase/migrations/` — mỗi thay đổi một file `<YYYYMMDDHHMMSS>_<mo_ta>.sql`.
🔵 CI chặn trùng version: `scripts/check-migration-versions.mjs`.
Kèm script xác minh: `supabase/verify/two_cameras_verify.sql`.

⚠️ **Đọc định nghĩa thật trên DB trước khi sửa** (nằm trong schema gốc, không có trong thư mục
migrations): `resolve_station_camera_at`, `resolve_scanner_at`, `process_staff_qr_session`, bảng
`staff_work_sessions`, constraint cột `warehouse_scan_raw_events.source`, dữ liệu `role_permission_matrix`.

| # | Nội dung | Dùng ở bước |
|---|---|---|
| M1 | `warehouse_agents.station_id` — máy tính thuộc bàn nào (một bàn tối đa một agent đang hoạt động) | 2, 3 |
| M2 | `user_profiles.station_id` — tài khoản bàn gắn với bàn nào | 3, 11 |
| M3 | `packing_stations.scan_source` (`scanner` \| `camera`, mặc định `scanner`) | 5, 10 |
| M4 | `cameras`: `rtsp_substream_path`, `agent_id`, `probe_failing_since`, `disconnect_alerted_at` | 4, 5, 18 |
| M5 | `camera_recording_files.agent_id` — segment nằm trên ổ máy nào | 2, 14 |
| M6 | `packing_events.proof_qr_camera_id` — chụp camera QR tại thời điểm quét | 14 |
| M7 | Hàm tra camera **theo vai trò** (`proof_primary` = toàn cảnh, `proof_qr`) của một bàn tại một thời điểm | 14 |
| M8 | Viết lại `process_waybill_scan` ghi thêm `proof_qr_camera_id`. 🔵 Chép nguyên bản mới nhất trong `20260807100000_packing_timing_single_source_180.sql` rồi thêm | 14 |
| M9 | `enqueue_start_recording`: **từ chối** khi camera thuộc agent khác | 2, 9 |
| M10 | **Trigger** trên bảng ca làm việc: khi bàn **không còn ca mở** → tạo lệnh `stop_recording` kèm thời điểm dừng = ra ca + 60 giây; khi bàn **có ca mở đầu tiên** → tạo lệnh `start_recording`. Trigger bắt được mọi đường đóng ca (ra ca thường, 🔵 `close_stale_sessions`) | 9 |
| M11 | `order_proof_clips`: `qr_camera_id`, `angles_present`, `layout`, `progress_percent`, `label_check`; **nới** 🔵 CHECK `progress_state` (hiện chỉ `encoding`) thêm `cutting`, `composing`, `uploading` | 15, 16 |
| M12 | Bảng mới **`order_proof_requests`**: đơn, người yêu cầu, thời điểm, trạng thái `waiting_agent` / `dispatched` / `done` / `failed`, lý do | 13 |
| M13 | 🔵 `reap_stale_agent_commands`: nhánh riêng cho `cut_clip`, trần 45 phút (khuôn: `20260705120000_reap_timeout_per_type_cut_clip.sql`) | 16 |
| M14 | CHECK `agent_commands.type` thêm: `connect_camera`, `test_qr_decode`, `live_remote_start`, `live_remote_stop` (khuôn: `20260708120000_discover_lan_command_type.sql`) | 4, 10, 12 |
| M15 | ⚠️ Nếu có CHECK: `warehouse_scan_raw_events.source` thêm `camera_qr` | 10 |
| M16 | `role_permission_matrix` thêm quyền: `packing_station.camera_setup` (Chủ sở hữu, Quản trị hệ thống), `live.view_remote` (cùng nhóm), `live.view_station` (tài khoản bàn) | 5, 11, 12 |
| M17 | `warehouse_agents.runtime_stats` (`jsonb`): bộ đọc mã, bộ mã hoá, trạng thái bộ chuyển luồng | 18 |

**Xong khi:** chạy trên DB thử; dữ liệu cũ không đổi (mọi cột mới cho phép rỗng, `scan_source` mặc định
`scanner`); script xác minh đạt.

---

## Bước 2 — Nhiều agent trong một tổ chức

**Mục tiêu:** mỗi máy bàn một agent chạy song song mà không giẫm lên nhau.

🔵 Hệ thống hiện giả định **1 tổ chức = 1 agent**, ghi rõ ở `src/lib/watch/agent-liveness.ts`,
`src/app/api/agent/boot-declare/route.ts`, và khối `BLOCKS-GO-LIVE` trong `warehouse-agent/src/recording.ts`.

**Hỏng ngay nếu bỏ qua bước này:**
- **Máy bàn 1 khởi động lại đóng phiên ghi hình của máy bàn 2** (boot-declare đóng theo tổ chức).
- Lệnh cắt clip gửi tới agent "mới liên lạc gần nhất" — **máy không có segment** → cắt thất bại.
- Mọi agent nhận **toàn bộ camera** của tổ chức.

| File | Việc |
|---|---|
| `src/lib/watch/agent-liveness.ts` | Trạng thái sống **theo agent của bàn**, không theo tổ chức |
| `src/app/api/agent/boot-declare/route.ts` | Chỉ đóng phiên của **camera thuộc chính agent đó** |
| `src/lib/agent-commands/enqueue.ts` | Lệnh camera gửi tới **agent sở hữu camera**; lệnh cắt clip gửi tới **agent giữ segment** |
| `src/app/api/cameras/[id]/recording/start/route.ts`, `stop/route.ts`, `status/route.ts`, `test-connection/route.ts`, `probe-codec/route.ts` | Chọn agent theo camera |
| `src/app/api/cameras/discover/route.ts` | Quét LAN bằng agent của bàn đang thiết lập |
| `src/app/api/order-proof/[pe_id]/watch/route.ts`, `watch/retry/route.ts` | Dùng agent của bàn của đơn |
| `src/lib/camera/active-credentials.ts`, `src/app/api/agent/recording-credentials/route.ts`, `src/app/api/agent/camera-probe/route.ts` | Chỉ trả camera **thuộc agent đang hỏi** |
| `src/app/api/agent/recording-files/route.ts` | Ghi `agent_id` cho segment (M5) |
| `src/lib/camera/service.ts`, `src/app/api/devices/route.ts`, `src/app/api/dashboard/overview/route.ts` | Trạng thái camera theo agent của camera |
| `src/lib/system/checks.ts` | Mục kiểm kết nối agent đánh giá **từng máy bàn**; **không báo lỗi khi máy bàn tắt ngoài ca** |

**Xong khi:** 2 máy bàn cùng tổ chức chạy song song; khởi động lại máy 1 không ảnh hưởng máy 2; lệnh
của bàn 2 luôn chạy trên máy 2.

---

## Bước 3 — Gắn agent với bàn, tài khoản với bàn

**Mục tiêu:** hệ thống biết máy tính nào, tài khoản nào thuộc bàn nào.

| File | Việc |
|---|---|
| `src/app/dashboard/agents/page.tsx` | Form tạo agent **thêm ô chọn bàn**. 🔵 Giữ nguyên luồng hiện tại: hiện secret **một lần**, admin chép mã + secret vào cửa sổ cài đặt |
| `src/app/api/warehouse/agents/route.ts`, `src/app/api/warehouse/agents/[id]/route.ts` | Nhận/đổi `station_id` (M1); một bàn chỉ một agent đang hoạt động |
| `src/app/api/warehouse/agents/[id]/reset-secret/route.ts` | 🔵 Không đổi — cài lại máy bàn dùng "Cấp secret mới" |
| `src/app/dashboard/users/page.tsx`, `src/app/api/users/route.ts`, `src/app/api/users/[id]/route.ts` | Tài khoản vai trò Nhân viên đóng gói **chọn được bàn** (M2) [GĐ4] |
| `src/lib/supabase/guard.ts` | Hàm tiện ích lấy **bàn của tài khoản đang đăng nhập** (dùng ở Bước 11) |

**Xong khi:** tạo agent gắn bàn; tạo tài khoản bàn gắn bàn.

---

# GIAI ĐOẠN B — THIẾT LẬP CAMERA

## Bước 4 — Agent: tìm và kết nối camera không cần biết hãng

**Mục tiêu:** admin chỉ cần chọn IP và nhập tài khoản.

| File | Mới/Sửa | Việc |
|---|---|---|
| `warehouse-agent/src/lan-discovery.ts` | Sửa | 🔵 Đã quét LAN (ONVIF + quét cổng + thử HTTP). **Chỉ trả thiết bị có dấu hiệu camera** (có ONVIF hoặc cổng RTSP) |
| `warehouse-agent/src/onvif-auth.ts` | **Mới** | Gọi ONVIF **có tài khoản** (WS-UsernameToken): lấy danh sách profile → **đường luồng chính và luồng phụ**, hãng, model. 🔵 Hiện `lan-onvif.ts` **chỉ tìm thiết bị**, chưa có phần này |
| `warehouse-agent/src/camera-connect.ts` | **Mới** | Luồng kết nối: ONVIF có tài khoản → nếu không được, **thử lần lượt các đường RTSP phổ biến** (🔵 danh sách có sẵn `COMMON_RTSP_PATHS` trong `src/lib/camera/discovery.ts`) theo hãng đoán được → chạy 🔵 `testCameraConnection` (ffmpeg lấy 1 khung) → trả đường luồng + hãng + codec. **Dừng ngay khi gặp lỗi sai tài khoản**, không thử tiếp các đường khác (tránh khoá camera) |
| `warehouse-agent/src/index.ts` | Sửa | Nhánh lệnh **`connect_camera`** (M14): nhận IP + username + password **từ payload lệnh, chỉ dùng trong bộ nhớ**, trả kết quả, không ghi ra ổ |
| `warehouse-agent/tests/camera-connect.test.ts` | **Mới** | Thứ tự thử; dừng khi sai tài khoản; không lộ mật khẩu vào log |

⚠️ Mật khẩu đi trong payload lệnh qua bảng `agent_commands`. Cloud phải **mã hoá phần mật khẩu trong
payload** (dùng 🔵 `src/lib/camera/crypto.ts`) và **xoá payload sau khi lệnh xong**; agent giải bằng
kênh xin tài khoản hiện có. [GĐ — thiết kế an toàn tối thiểu]

**Xong khi:** với camera của ít nhất 2 hãng khác nhau, chỉ nhập IP + tài khoản là nhận được luồng.

---

## Bước 5 — Cloud API: thiết lập camera, nguồn đọc mã

| File | Mới/Sửa | Việc |
|---|---|---|
| `src/app/api/packing-stations/[id]/cameras/route.ts` | **Mới** | Luồng thiết lập một camera cho bàn: tạo lệnh `connect_camera` → kết quả thành công thì **lưu camera** (🔵 qua `src/lib/camera/service.ts`, mật khẩu mã hoá), gán **vai trò** (toàn cảnh / QR), gán `agent_id` của bàn, **tự bật ghi nếu bàn đang có ca mở**. Camera đang thuộc bàn khác → trả thông tin để hỏi xác nhận; xác nhận thì **gỡ khỏi bàn cũ, gán bàn mới**, ghi nhật ký. Quyền `packing_station.camera_setup` (M16) |
| `src/app/api/packing-stations/[id]/route.ts` | Sửa | Nhận `scan_source`; ghi nhật ký (🔵 `src/lib/audit.ts`). Chọn `camera` chỉ khi bàn đã có camera QR kết nối được |
| `src/app/api/packing-stations/route.ts` | Sửa | Trả `scan_source`, 2 camera của bàn, trạng thái kết nối |
| `src/app/api/station-device-assignments/route.ts` | Sửa | Khi gán camera vai trò QR: **tự tạo thiết bị quét ảo** `qrcam_<camera_code>` gán cùng bàn — để 🔵 `resolve_scanner_at` và `process_waybill_scan` chạy nguyên trạng với sự kiện từ camera |
| `src/app/api/station-devices/route.ts`, `[id]/route.ts` | Sửa | 🔵 Hiện `config_json.role` chỉ có `proof_primary` → thêm `proof_qr`; một bàn tối đa một camera mỗi vai trò |
| `src/app/api/warehouse/scans/route.ts` | Sửa | Thêm nguồn `camera_qr`. **Chặn nguồn không được chọn**: tra bàn (🔵 route đã gọi `resolve_scanner_at`), so với `scan_source`; lệch → **lưu sự kiện thô, không gọi RPC tạo đơn**, trả cảnh báo `scan_source_disabled` |
| `src/app/api/warehouse/manual-scan/route.ts` | Sửa | Bàn chọn camera → **từ chối** |
| `src/app/api/cameras/discover/route.ts` | Sửa | Trả thêm "đang dùng bởi bàn nào" cho IP đã có trong hệ thống |
| `src/lib/camera/codec-invalidation.ts` | Sửa | 🔵 Thêm `rtsp_substream_path` vào `CONNECTION_FIELDS` |

**Xong khi:** gọi API thiết lập được 2 camera cho một bàn; đổi nguồn có nhật ký; quét từ nguồn đang tắt
không tạo đơn.

---

## Bước 6 — Cloud UI: trang "Bàn đóng hàng"

**File chính:** `src/app/dashboard/packing-stations/page.tsx`

```
Bàn 01 ─────────────────────────────────────────────────────────────
  Nguồn đọc mã:     ( ) Máy quét    (•) Camera

  Camera toàn cảnh:  192.168.1.21  ● Đã kết nối      [ Đổi ] [ Gỡ ]
  Camera quét QR:    — chưa có —                     [ + Kết nối camera ]
                        │
                        ▼
      ┌─ Kết nối camera ─────────────────────────────────────────┐
      │ [ Quét mạng LAN ]                                        │
      │  ○ 192.168.1.21  Hikvision   Đang dùng bởi Bàn 01        │
      │  ● 192.168.1.35  Dahua                                   │
      │  ○ 192.168.1.40  (không rõ hãng)  Đang dùng bởi Bàn 03   │
      │                                                          │
      │ Username [          ]   Password [          ]            │
      │ Vai trò:  ( ) Toàn cảnh   (•) Quét QR                    │
      │                                   [ Kết nối ]            │
      └──────────────────────────────────────────────────────────┘
      Chọn camera "Đang dùng bởi Bàn 03" → hỏi: "Chuyển camera này sang Bàn 01?"
      Sai tài khoản → "Sai username hoặc password. Camera có thể tự khoá sau vài lần sai."

  [ Kiểm tra đọc mã ]   → lệnh test_qr_decode (Bước 10)
```

| File | Mới/Sửa | Việc |
|---|---|---|
| `src/app/dashboard/packing-stations/page.tsx` | Sửa | Khối thiết lập như trên; ẩn với vai trò không có quyền |
| `src/components/packing-stations/CameraConnectModal.tsx` | **Mới** | Hộp thoại quét LAN + chọn IP + nhập tài khoản + vai trò; chờ kết quả lệnh |
| `src/components/devices/CamerasView.tsx` | Sửa | Hiện vai trò và bàn của camera; thao tác thêm/sửa camera **chuyển sang trang Bàn đóng hàng** |
| `src/components/warehouse-config/DevicesTab.tsx` | Sửa | 🔵 Ô "camera chính" (`camera_role_primary`) đổi thành vai trò Toàn cảnh / Quét QR |
| `src/app/dashboard/packing/scan/page.tsx` | Sửa | Bàn chọn camera → hiện "Bàn này dùng camera để đọc mã", khoá ô nhập |

**Xong khi:** admin thiết lập đủ một bàn thật chỉ bằng giao diện.

---

## Bước 7 — Cloud → agent: cấu hình của bàn

**Mục tiêu:** agent tự biết camera nào, vai trò gì, nguồn đọc mã nào, bàn có ca mở không.

| File | Việc |
|---|---|
| `src/lib/camera/active-credentials.ts` | Trả camera của agent kèm: vai trò, đường luồng chính + phụ (giải mã mật khẩu), `scan_source` của bàn, mã thiết bị quét ảo, **bàn có ca mở hay không** |
| `src/app/api/agent/camera-probe/route.ts` | 🔵 Danh sách đã đi kèm phản hồi kiểm camera mỗi 30 giây → mang theo cấu hình mới → đổi thiết lập có hiệu lực **≤ 30 giây** |
| `src/app/api/agent/recording-credentials/route.ts` | Trả cùng dữ liệu cho lúc khởi động |
| `warehouse-agent/src/commands.ts`, `warehouse-agent/src/camera-probe.ts` | Bổ sung kiểu dữ liệu |

**Xong khi:** đổi nguồn đọc mã trên giao diện → log agent ghi nhận trong 30 giây.

---

# GIAI ĐOẠN C — ĐỌC MÃ + GHI HÌNH THEO CA + XEM TRỰC TIẾP

## Bước 8 — Agent: bộ chuyển luồng nội bộ (mediamtx)

**Mục tiêu:** một điểm lấy luồng camera cho bộ đọc mã, xem trên máy bàn, xem từ xa — giảm số kết nối
vào camera. **Ghi hình không đi qua đây.**

| File / Thư mục | Mới/Sửa | Việc |
|---|---|---|
| `warehouse-agent/vendor/mediamtx/` | **Mới** | File chạy mediamtx + giấy phép (🔵 cùng kiểu `vendor/nssm/`) |
| `warehouse-agent/src/live/relay-hub.ts` | **Mới** | Sinh cấu hình mediamtx từ danh sách camera (Bước 7); mỗi camera một đường, **chỉ kéo luồng khi có người đọc**; **chỉ nghe `127.0.0.1`**; khởi động/giám sát/khởi động lại tiến trình; cho phép gọi từ nguồn gốc dashboard (CORS + quyền mạng cục bộ) |
| `warehouse-agent/src/index.ts` | Sửa | Khởi bộ chuyển luồng khi agent chạy; dừng khi tắt agent (trong 🔵 ngân sách 4500 ms) |
| `warehouse-agent/installer/betacom-agent.iss`, `warehouse-agent/scripts/build-installer.ps1` | Sửa | Đóng kèm mediamtx |

**Xong khi:** trên máy bàn mở được luồng WebRTC của cả 2 camera qua `127.0.0.1`.

---

## Bước 9 — Ghi hình theo ca

**Mục tiêu:** ghi từ lúc mở ca đầu tiên tới 60 giây sau lúc ra ca cuối; không mất video khi mất mạng.

**Luồng:**

```
Agent đọc được QR nhân viên (camera hoặc máy quét của bàn)
   → BẬT GHI NGAY tại chỗ (không chờ cloud)                        [chống mất video khi mất mạng]
   → gửi sự kiện lên cloud như bình thường

Cloud xử lý ca (process_staff_qr_session)
   → trigger M10: bàn có ca mở đầu tiên → lệnh start_recording     [đường chính khi có mạng]
   → trigger M10: bàn không còn ca mở   → lệnh stop_recording, dừng lúc = ra ca + 60 giây

Agent nhận stop_recording
   → chờ tới thời điểm dừng → nếu trong lúc chờ có người mở ca → HUỶ dừng
   → dừng ghi an toàn (🔵 ffmpeg nhận q, ghi xong phần cuối file)

Bật máy buổi sáng
   → agent hỏi cloud: bàn có ca mở không? → có thì ghi lại, không thì chờ QR mở ca   [GĐ2]
```

| File | Việc |
|---|---|
| `supabase/migrations/…` (M10) | Trigger tạo lệnh bật/dừng |
| `warehouse-agent/src/recording-lifecycle.ts` | 🔵 Hiện "ý định ghi" (`desired-recording.json`) giữ qua khởi động lại → **khi khởi động, chỉ ghi lại nếu cloud xác nhận bàn có ca mở**; nhận thời điểm dừng trễ và huỷ khi có người mở ca lại |
| `warehouse-agent/src/shift-recording.ts` | **Mới** — nhận sự kiện QR nhân viên đọc được tại chỗ → bật ghi cho camera của bàn (toàn cảnh; và QR nếu nguồn = camera) |
| `warehouse-agent/src/index.ts` | Nối sự kiện QR nhân viên từ máy quét (🔵 `scanner.ts`) và từ bộ đọc mã (Bước 10) vào `shift-recording.ts` |
| `warehouse-agent/src/commands.ts` | Payload `stop_recording` thêm thời điểm dừng |
| `src/lib/agent-commands/enqueue.ts` | Tạo lệnh cho **mọi camera của bàn** theo vai trò và nguồn |
| `src/app/api/cameras/[id]/recording/start/route.ts` | Giữ cho thao tác tay của admin khi cần |

**Vì sao trễ 60 giây:** 🔵 clip đơn cuối lấy thêm **5 giây** sau khi đơn kết thúc
(`src/lib/order-proof/clip-window.ts`) + **3 giây** đệm keyframe (`src/lib/agent-commands/enqueue.ts`) +
segment đang ghi phải đóng xong.

**Xong khi:** mở ca → ghi; đổi người → vẫn ghi; ra ca cuối → dừng sau 60 giây; rút mạng rồi mở ca → vẫn
ghi; tắt máy khi còn ca, bật lại → ghi tiếp.

---

## Bước 10 — Agent: đọc mã QR

**Mục tiêu:** camera đọc mã thay máy quét, xử lý giống máy quét.

### Thư viện

| Thư viện | Dùng cho |
|---|---|
| **`zxing-wasm`** (ghim phiên bản) | Giải mã QR. WebAssembly, đóng gói được vào `.exe` (file `.wasm` đưa vào `pkg.assets`) |
| mediamtx (Bước 8) | Cấp luồng phụ camera QR |
| ffmpeg (🔵 đã đóng kèm) | Trích khung ảnh xám ~10 khung/giây từ mediamtx |

### File

| File | Mới/Sửa | Việc |
|---|---|---|
| `warehouse-agent/src/qr/qr-frame-source.ts` | Mới | Lấy **luồng phụ camera QR qua mediamtx**, trích khung, **luôn đọc hết đầu ra, bỏ khung thừa** khi bộ giải mã bận, tự chạy lại khi lỗi |
| `warehouse-agent/src/qr/qr-decoder.ts` | Mới | Giải mã một khung → nội dung mã, vị trí, bề rộng |
| `warehouse-agent/src/qr/qr-zone.ts` | Mới — **hàm thuần** | Máy trạng thái vùng quét (dưới) |
| `warehouse-agent/src/qr/qr-scan-service.ts` | Mới | Chạy cho camera QR của bàn có `scan_source = camera`; **chạy cả khi không ghi hình** (để nhận QR mở ca); dừng khi nguồn = máy quét |
| `warehouse-agent/src/index.ts` | Sửa | Đẩy sự kiện vào 🔵 **hàng đợi quét có sẵn** (`queue.ts`) với nguồn `camera_qr`, mã thiết bị quét ảo; sự kiện QR nhân viên đồng thời báo `shift-recording.ts` (Bước 9); nhánh lệnh `test_qr_decode` (chạy ~10 giây, trả các mã đọc được, không tạo đơn) |
| `warehouse-agent/src/config.ts` | Sửa | Chỉ tham số tinh chỉnh (khung/giây, số khung xác nhận, thời gian vắng 2 giây) |
| `warehouse-agent/package.json` | Sửa | Thêm `zxing-wasm`; `.wasm` vào `pkg.assets` |
| `warehouse-agent/tests/qr-zone.test.ts` | Mới | Các ca ở dưới |

### Máy trạng thái vùng quét

```
               1 mã X ổn định ≥ 2 khung
  ┌────────┐ ───────────────────────────►  ┌──────────────────────┐
  │ TRỐNG  │                                │ ĐƠN HIỆN TẠI = X     │  ← PHÁT X  + báo "Đã nhận"
  └────────┘                                └──────────────────────┘
                                              │
     X bị tay/thùng che, X hiện lại ──────────┤  KHÔNG BAO GIỜ phát lại X
                                              │
     mã Y ≠ X ổn định ≥ 2 khung               │
     VÀ X vắng ≥ 2 giây ──────────────────────┘  → PHÁT Y (cloud tự đóng đơn X) + "Đã nhận"

  Khung có ≥ 2 mã khác nhau → bỏ khung + báo "Có 2 mã QR"
```

- `scanned_at` = **khung đầu tiên thấy mã** mới.
- Ghi vào `device_identity_snapshot` của sự kiện: `first_seen_at`, `best_frame_at`, `qr_box` — dùng cho
  kiểm nhãn đọc được ở Bước 15 (🔵 nối tới đơn qua `packing_events.raw_event_id`, không cần thêm cột).
- 🔵 Dùng lại bộ lọc log `stripNoisyFfmpegLines` cho tiến trình trích khung.

**Test bắt buộc:** nhãn nằm trong vùng 3 phút bị che nhiều lần chỉ phát 1 lần · đổi nhãn phát đúng 1 lần ·
vắng 1,5 giây rồi hiện lại không phát · 2 mã trong khung không phát · `scanned_at` đúng khung đầu.

**Xong khi:** chạy bộ đọc mã trên video đã ghi 3 ngày: số đơn khớp máy quét; 0 lần phát lại do che nhãn.

---

## Bước 11 — Trang máy bàn: xem trực tiếp + thông báo

**Mục tiêu:** một trang trên máy bàn hiện 2 camera đúng bố cục video xuất, kèm thông báo.

### Cách hoạt động

- Trang là **trang dashboard trên cloud** (HTTPS), đăng nhập bằng **tài khoản bàn**.
- Video lấy **trực tiếp từ mediamtx trên chính máy bàn** qua `127.0.0.1`, không đi qua cloud. Trình duyệt
  coi `127.0.0.1` là địa chỉ an toàn nên trang HTTPS gọi được; ⚠️ các bản Chrome/Edge mới có thể hỏi quyền
  "truy cập mạng cục bộ" — kiểm ở Bước 0.
- **Bố cục dựng trên trình duyệt**: camera toàn cảnh toàn khung; camera QR (luồng chính) vào ô 1/9 góc
  trên phải, viền trắng mảnh; dải thông tin đơn đang đóng ở đáy.
- **Thông báo** nhận từ agent qua `127.0.0.1` (Server-Sent Events) → "Đã nhận" + tiếng, "Có 2 mã QR",
  "Nguồn đang tắt".
- **Sau ra ca cuối:** trang hiện "Bàn đã kết thúc ca", không kéo video.

| File | Mới/Sửa | Việc |
|---|---|---|
| `src/app/dashboard/station/page.tsx` | **Mới** | Trang máy bàn; chỉ tài khoản có `live.view_station` và **bàn của chính tài khoản** |
| `src/components/station/LiveLayout.tsx` | **Mới** | Bố cục toàn cảnh + ô 1/9 + dải thông tin; **dùng chung** cho xem từ xa (Bước 12) |
| `src/components/station/StationNotifications.tsx` | **Mới** | Thông báo + âm thanh |
| `src/app/api/station/current-order/route.ts` | **Mới** | Đơn đang mở của bàn cho dải thông tin (poll qua 🔵 `startVisibilityPolling`) |
| `warehouse-agent/src/station-notifier.ts` | **Mới** | Server-Sent Events trên `127.0.0.1`, dùng `node:http` có sẵn |
| `src/lib/nav.ts` | Sửa | Tài khoản bàn chỉ thấy trang này |
| `warehouse-agent/installer/betacom-agent.iss` | Sửa | Tạo lối tắt khởi động cùng Windows mở trình duyệt **toàn màn hình** vào trang máy bàn |

⚠️ Trình duyệt chặn tự phát tiếng khi chưa bấm gì → cờ trình duyệt cho phép tự phát âm thanh trong lối
tắt khởi động.

**Xong khi:** bật máy bàn → trang tự mở toàn màn hình → mở ca → thấy 2 camera đúng bố cục → đặt nhãn →
"Đã nhận" trong ≤ 1 giây.

---

## Bước 12 — Xem trực tiếp từ xa qua VPS

**Mục tiêu:** admin xem trực tiếp bất kỳ bàn nào qua Internet.

### Cách hoạt động

```
Admin mở xem Bàn 01 trên dashboard
  → API kiểm quyền live.view_remote + bàn thuộc tổ chức + bàn đang có ca mở
  → tạo lệnh live_remote_start cho agent Bàn 01
  → agent đẩy 2 LUỒNG PHỤ (sao chép, không mã hoá lại) từ mediamtx máy bàn → mediamtx trên VPS
  → trình duyệt admin nhận WebRTC từ VPS, dựng bố cục bằng LiveLayout (dùng chung Bước 11)

mediamtx VPS hỏi Next.js mỗi lần có người đẩy / người xem  → xác thực + chặn chéo tổ chức
10 phút không thao tác → trang tự ngắt; không còn người xem → lệnh live_remote_stop
Tối đa 2 admin xem cùng lúc một bàn
```

| File / Thư mục | Mới/Sửa | Việc |
|---|---|---|
| `docs/vps/betabox-media.service` | **Mới** | Dịch vụ mediamtx trên VPS (🔵 cùng kiểu `docs/vps/betabox-syscheck.service`) |
| `docs/vps/mediamtx.yml` | **Mới** | Cấu hình: xác thực qua HTTP gọi Next.js; WebRTC; cổng |
| `src/app/api/live/media-auth/route.ts` | **Mới** | mediamtx VPS gọi vào để xác thực người đẩy (agent) và người xem (admin); kiểm đúng tổ chức, đúng bàn, tối đa 2 người xem |
| `src/app/api/live/[stationId]/remote/route.ts` | **Mới** | Bắt đầu / dừng xem từ xa; cấp token xem ngắn hạn |
| `src/app/dashboard/operations/page.tsx` | Sửa | Nút **"Xem trực tiếp"** trên thẻ từng bàn |
| `src/components/station/RemoteLiveModal.tsx` | **Mới** | Cửa sổ xem từ xa dùng `LiveLayout`; tự ngắt sau 10 phút không thao tác |
| `warehouse-agent/src/live/remote-publish.ts` | **Mới** | Đẩy 2 luồng phụ lên VPS khi có lệnh; tự dừng khi hết hạn |
| `warehouse-agent/src/index.ts` | Sửa | Nhánh lệnh `live_remote_start`, `live_remote_stop` |
| `src/lib/agent-commands/enqueue.ts` | Sửa | Tạo 2 lệnh trên |

⚠️ Mở cổng WebRTC trên tường lửa VPS. ⚠️ Kiểm phiên bản mediamtx có xác thực qua HTTP.

**Xong khi:** admin ở ngoài kho xem được Bàn 01; admin thứ 3 bị từ chối; 10 phút không thao tác thì ngắt;
tài khoản tổ chức khác không xem được.

---

# GIAI ĐOẠN D — VIDEO BẰNG CHỨNG

## Bước 13 — Yêu cầu video + hàng chờ khi máy bàn tắt

**Mục tiêu:** yêu cầu lúc máy bàn tắt không bị mất.

🔵 Hiện `/watch` kiểm agent offline **trước khi** tạo lệnh cắt → trả "kho offline", **không lưu yêu cầu**
(`src/app/api/order-proof/[pe_id]/watch/route.ts`).

**Luồng mới:**

```
Người dùng mở video một đơn
  ├─ clip đã có trên Supabase     → phát (không đổi)
  ├─ máy bàn đang bật             → tạo lệnh ghép (không đổi)
  └─ máy bàn đang tắt             → lưu order_proof_requests = waiting_agent
                                    dòng đơn hiện "Chờ máy bàn bật"

Máy bàn bật (agent gửi heartbeat)
  → cloud lấy các yêu cầu waiting_agent của bàn đó → tạo lệnh ghép → dispatched
  → dòng đơn hiện "Đang ghép" → xong → "Sẵn sàng"
  → segment gốc đã quá 30 ngày → failed → "Không còn video gốc"
```

| File | Việc |
|---|---|
| `src/app/api/order-proof/[pe_id]/watch/route.ts` | Máy bàn tắt → lưu yêu cầu thay vì chỉ trả "offline"; mỗi đơn một yêu cầu đang chờ |
| `src/app/api/warehouse/heartbeat/route.ts` | Mỗi lần agent báo sống → chuyển các yêu cầu chờ của bàn thành lệnh ghép |
| `src/app/api/order-proof/scans/route.ts` | Trả trạng thái yêu cầu cho từng dòng đơn |
| `src/app/dashboard/videos/page.tsx` | Hiện trạng thái trên dòng đơn cho **mọi người có quyền xem clip** |
| `src/lib/order-proof/stale-pending.ts` | 🔵 Không đổi — vẫn là lớp dọn clip kẹt |

**Xong khi:** tắt máy bàn → mở video → "Chờ máy bàn bật" → bật máy → tự thành "Sẵn sàng" mà người dùng
không thao tác gì.

---

## Bước 14 — Cloud: xác định đoạn video cho 2 camera

| File | Việc |
|---|---|
| `src/lib/order-proof/clip-window.ts` | 🔵 **Không đổi** — cửa sổ thời gian dùng chung 2 camera |
| `src/lib/order-proof/proof-clip-gate.ts` | 🔵 **Không đổi** — đơn còn mở thì không cắt |
| `src/lib/order-proof/clip-resolver.ts` | Lấy **2 camera** từ `proof_camera_id` và `proof_qr_camera_id` (đơn cũ: tra theo vai trò, M7). Truy vấn segment **riêng từng camera**, lọc thêm **agent đang giữ segment** (M5). Trả trạng thái từng góc |
| `src/lib/order-proof/open-segment-verdict.ts` | 🔵 **Không đổi** — gọi cho **từng góc** |
| `src/lib/agent-commands/enqueue.ts` | Payload: 2 góc + segment từng góc; **dải thông tin** (mã vận đơn, kho, bàn, mã nhân viên · họ tên, thời gian đóng đơn); bố cục `pip / top_right / 1/9 / viền trắng`; `best_frame_at` từ sự kiện quét gốc. 🔵 Góc QR đi trong các trường `jsonb` của RPC `enqueue_clip_generation` → không đổi chữ ký RPC |

**Luật thiếu góc:**

| Toàn cảnh | Camera QR | Kết quả |
|---|---|---|
| có | có | Ghép 2 góc |
| có | thiếu (hoặc bàn dùng máy quét) | Video toàn cảnh + dòng "KHÔNG CÓ VIDEO GÓC QUÉT MÃ" (bàn dùng máy quét thì không hiện dòng này) |
| thiếu | có | Camera QR toàn khung + dòng "KHÔNG CÓ VIDEO GÓC TOÀN CẢNH" |
| thiếu | thiếu | Lỗi như hiện tại |

**Xong khi:** lệnh cắt trong DB có đủ 2 góc, dải thông tin, bố cục.

---

## Bước 15 — Agent: cắt 2 video, ghép 1 video

| File | Mới/Sửa | Việc |
|---|---|---|
| `warehouse-agent/src/clip-cutter.ts` | Sửa | Thêm **nối segment không cắt** cho từng góc; giữ hàm cắt 1 góc cũ |
| `warehouse-agent/src/compose/compose-plan.ts` | Mới — **hàm thuần** | Tính độ lệch từng góc, thời lượng, **ô 640×360 tại (1280, 0)**, bitrate theo thời lượng, nội dung dải thông tin |
| `warehouse-agent/src/compose/clip-composer.ts` | Mới | Chạy ffmpeg ghép 1920×1080; đọc tiến độ; dự phòng bộ mã hoá |
| `warehouse-agent/src/compose/encoder-detect.ts` | Mới | Lúc khởi động: **thử mã hoá thật** `h264_qsv` → `h264_nvenc` → `libx264` |
| `warehouse-agent/src/compose/font-extract.ts` | Mới | Chép font từ trong `.exe` ra `data/fonts/` (ffmpeg không đọc được file bên trong `.exe`). 🔵 `NotoSans-Bold.ttf` còn trong `pkg.assets` |
| `warehouse-agent/src/index.ts` | Sửa | Nhánh `cut_clip`: chuỗi dưới; **giữ nguyên** các bước signed URL, upload, báo hoàn tất, đổi tên file |
| `warehouse-agent/src/clip-size-guard.ts` | Không đổi | 🔵 Trần 90 MiB |
| `warehouse-agent/tests/compose-plan.test.ts` | Mới | Toạ độ ô 1/9; độ lệch khi 2 góc khác giây bắt đầu; thiếu góc; bitrate clip dài; tiếng Việt và ký tự đặc biệt trong dải thông tin |

### Chuỗi xử lý

```
1. Kiểm segment 2 góc còn trên ổ
2. Tiến độ: cutting
3. Nối segment camera toàn cảnh → A     (sao chép luồng, KHÔNG cắt, vài giây)
4. Nối segment camera QR        → B     (sao chép luồng, KHÔNG cắt, vài giây)
5. Tiến độ: composing
6. Ghép (trong EncodeGate — 1 clip mỗi lúc):
     A cắt chính xác → 1920×1080
     B cắt chính xác → 640×360 tại (1280, 0), viền trắng mảnh
     dải thông tin ở đáy
     mã hoá H.264, không âm thanh
7. Kiểm file ghép:
     codec H.264 · 1920×1080 · thời lượng · ≤ 90 MiB
     trích khung tại best_frame_at, cắt ô 1/9, GIẢI MÃ LẠI mã QR
       không đạt → ghép lại 1 lần với bitrate cao hơn → vẫn không đạt → upload + label_check = failed
8. Xoá A, B
9. Tiến độ: uploading → signed URL → upload → báo hoàn tất        (không đổi)
```

### Ba điểm mấu chốt

1. **Nối không cắt ở bước 3–4, cắt chính xác ở bước 6.** 🔵 Cắt bằng sao chép luồng làm tròn điểm bắt đầu
   về keyframe; mỗi góc tròn về một keyframe khác → **2 góc lệch nhau không đo được**.
2. **Quy tắc `-ss` đảo chiều.** 🔵 Nối nhiều file: `-ss` đặt **sau** `-i` (bài học clip 74 giây thay vì 29
   ghi trong `clip-cutter.ts`). Bước 6 đầu vào là **một file**: `-ss` đặt **trước** `-i`. Ghi chú ở cả hai chỗ.
3. **Hai camera khác hãng lệch thời gian cố định.** Hiệu chỉnh độ lệch theo từng bàn bằng **đồng hồ in
   trên hình** của 2 camera (tua từng khung tìm lúc 2 đồng hồ cùng nhảy giây), lưu vào cấu hình camera QR.

**Xong khi:** clip 3 phút ghép đúng bố cục; đọc được chữ 3 mm trong ô 1/9; kiểm tự động đạt.

---

## Bước 16 — Tiến độ + gia hạn lệnh

**Bắt buộc phát hành cùng Bước 15.** 🔵 Hệ thống thu hồi lệnh `taken` sau **2 phút**; ghép mất vài phút.
Đội cũ đã gặp đúng vòng lặp "thu hồi giữa chừng → cắt lại từ đầu" khi mã hoá lúc cắt (migration
`20260705120000`).

| File | Việc |
|---|---|
| `src/app/api/agent/clip-cut-result/route.ts` | Nhận `stage`, `percent`; mỗi lần nhận → **làm mới `taken_at`** của lệnh `cut_clip` đó (đúng agent đã xác thực) |
| `supabase/migrations/…` (M13) | Trần an toàn 45 phút |
| `src/app/api/order-proof/[pe_id]/watch/route.ts` | Trả giai đoạn + phần trăm cả cho lần ghép đầu |
| `src/lib/watch/use-watch-clip-state.ts` | Nhận giai đoạn + phần trăm |
| `src/app/dashboard/videos/page.tsx` | "Đang nối video… / Đang ghép 2 góc 45% / Đang tải lên" |
| `src/lib/order-proof/stale-pending.ts` | 🔵 Không đổi |

**Xong khi:** ghép > 2 phút không bị thu hồi; tắt agent giữa chừng → lệnh thu hồi sau ~2 phút → quay lại
hàng chờ (Bước 13).

---

## Bước 17 — Upload, xem, tải về

**Upload và xem — không đổi:** 🔵 `src/app/api/agent/clip-upload-url/route.ts`,
`warehouse-agent/src/upload.ts`, `src/app/api/agent/clip-upload-complete/route.ts`, RPC
`promote_clip_generation`, `src/lib/watch/proof-clip-signed-url.ts`. Clip trên Supabase **72 giờ**.

**Tải về — mới:**

| File | Mới/Sửa | Việc |
|---|---|---|
| `src/lib/watch/proof-clip-signed-url.ts` | Sửa | Thêm biến thể **URL tải về** kèm tên file `<mã vận đơn>_<ngày>-<giờ>.mp4`. 🔵 **Chỉ được sửa ở file này** — `scripts/check-proof-clip-signed-url.mjs` chặn build nếu cấp URL ở chỗ khác |
| `src/app/api/order-proof/[pe_id]/download/route.ts` | Mới | Quyền **xem clip hiện có** (`order_proof.view`); clip phải sẵn sàng; **ghi nhật ký** tải (🔵 `src/lib/audit.ts`) |
| `src/app/dashboard/videos/page.tsx` | Sửa | Nút **"Tải video"** |

Sau 72 giờ clip bị dọn → bấm tải sẽ chạy lại luồng yêu cầu (Bước 13) → ghép lại từ segment gốc.

**Xong khi:** tải được file đúng tên; nhật ký ghi lại.

---

# GIAI ĐOẠN E — VẬN HÀNH

## Bước 18 — Cảnh báo, giám sát

| File | Việc |
|---|---|
| `src/app/api/agent/camera-probe/route.ts` | Ghi `probe_failing_since` khi camera bắt đầu lỗi; lỗi **≥ 2 phút** và **máy bàn đang bật** [GĐ5] → phát cảnh báo một lần |
| `src/lib/lark/messages.ts`, `src/lib/lark/notify-warehouse-issue.ts` | Loại sự kiện mới **"camera mất kết nối"** (🔵 dùng lại webhook theo kho + chống gửi lặp) |
| `src/lib/warehouse/live/issues.ts`, `src/app/api/warehouse/live/issues/route.ts` | Hiện camera mất kết nối trong danh sách sự cố [GĐ6] |
| `warehouse-agent/src/heartbeat.ts` → `src/app/api/warehouse/heartbeat/route.ts` | Gửi trạng thái bộ đọc mã, bộ mã hoá, bộ chuyển luồng (M17) |
| `src/lib/system/checks.ts`, `src/lib/system/status-view.ts` | Mục kiểm: bàn đang có ca mà bộ đọc mã không chạy; tỉ lệ clip `label_check = failed` |

**Xong khi:** rút cáp camera QR lúc có ca → sau 2 phút có tin Lark + dòng sự cố; tắt máy bàn cuối ngày
→ **không** có cảnh báo.

---

## Bước 19 — Kiểm thử, đóng gói, chạy thử

| Việc | Đường dẫn / lệnh |
|---|---|
| Test cloud | `tests/` — 🔵 `pnpm test` |
| Test agent | `warehouse-agent/tests/` — `camera-connect`, `qr-zone`, `compose-plan` |
| 🔵 Đồng bộ đường dẫn API agent | Thêm endpoint agent thì sửa **cả** `src/lib/warehouse/agent-api-paths.ts` **và** `warehouse-agent/src/agent-api-paths.ts`; chạy `warehouse-agent/tests/agent-api-paths-mirror.test.ts` |
| 🔵 Guard CI | `scripts/check-tenant-scoped-writes.mjs`, `check-agent-routes-use-verify-agent-request.mjs`, `check-proof-clip-signed-url.mjs`, `check-migration-versions.mjs`, `check-audit-destruct-error.mjs` |
| Kiểm kiểu | `pnpm typecheck`, `pnpm typecheck:tests` |
| Đóng gói agent | `warehouse-agent/`: `pnpm run build:exe`, Inno Setup `installer/betacom-agent.iss` (thêm mediamtx, lối tắt trang máy bàn) |
| VPS | Cài `docs/vps/betabox-media.service` + `docs/vps/mediamtx.yml`; mở cổng WebRTC |
| Ghi phiên bản | `warehouse-agent/RELEASES.md` |
| **Chạy thử** | **2 bàn** (để kiểm nhiều agent), 1–2 tuần |

**Tiêu chí chạy thử:**

| Chỉ số | Ngưỡng |
|---|---|
| Đơn đọc bằng camera so với thực tế | Không sót |
| Phát lại do che nhãn | 0 |
| Từ đặt nhãn tới "Đã nhận" | ≤ 1 giây |
| Ghi hình: mở ca → ghi, ra ca cuối → dừng sau 60 giây | Đúng 100% ngày chạy thử |
| Khởi động lại máy bàn 1 | Máy bàn 2 không bị ảnh hưởng |
| Clip 3 phút ghép xong | 🟡 ≤ 3 phút với mã hoá phần cứng |
| Chữ nhãn đọc được bằng mắt (mẫu 50 clip) | 100% |
| Yêu cầu lúc máy bàn tắt | Tự "Sẵn sàng" sau khi bật máy |
| Xem từ xa | Chạy; tự ngắt 10 phút; chặn người thứ 3 |

---

## Phụ lục — Số liệu dùng trong tài liệu

| Đại lượng | Giá trị | Nguồn |
|---|---|---|
| Chữ 3 mm trong ô 1/9 | 🟡 ~9,6 điểm ảnh (640 px ÷ vùng nhìn 200 mm × 3 mm) | Tính |
| Dung lượng ghi mỗi máy bàn | 🟡 ~18 GB/ngày (2 camera, ~10 giờ) → ~540 GB / 30 ngày | Tính từ 🔵 bitrate ~256 KB/s ghi trong `clip-resolver.ts` |
| Clip 3 phút sau ghép | 🟡 ~45–70 MiB | Kế hoạch ghép |
| Đẩy clip lên ở 10 Mbps | 🟡 ~45–60 giây | Tính |
| Xem từ xa mỗi bàn | 🟡 ~1–2 Mbps (2 luồng phụ) | Thông số luồng phụ thường gặp |
| Trần upload clip | 🔵 90 MiB (`MAX_PROOF_CLIP_UPLOAD_BYTES`) | `warehouse-agent/src/config.ts` |
| Thu hồi lệnh | 🔵 2 phút | `reap_stale_agent_commands` |
| Đệm sau đơn + đệm keyframe | 🔵 5 giây + 3 giây | `clip-window.ts`, `enqueue.ts` |
| Clip trên Supabase | 🔵 72 giờ | `src/lib/watch/config.ts` |
