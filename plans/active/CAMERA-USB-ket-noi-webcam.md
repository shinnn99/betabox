# CAMERA USB — Cho hệ thống nhận cả webcam cắm thẳng vào máy kho

**Trạng thái:** Kế hoạch, chưa viết dòng mã nào
**Ngày:** 25/09/2026
**Chủ dự án chốt:** hệ thống phải kết nối được **cả camera USB** bên cạnh camera IP đang dùng.
**Liên quan:** `E.1-ip-camera-co-dinh-va-remote-live.md` (định danh camera), `C.1.1-mediamtx-local-relay.md` (relay), `C.1.3-camera-qr-reader.md` (đọc QR)

---

## 0. Kết luận trước, lý lẽ sau

**Cách làm ít rủi ro nhất: đẩy webcam vào chính relay MediaMTX đang chạy, tại đúng đường dẫn mà camera IP đang dùng.** Làm vậy thì mọi thứ phía sau — xem trực tiếp, đọc QR, ghi hình, cắt clip, gán bàn, phiên hoàn hàng — **dùng lại nguyên vẹn, không sửa một dòng**, vì chúng đều đọc từ `rtsp://127.0.0.1:8554/<đường_dẫn>` chứ không đọc thẳng từ camera.

```
Camera IP  ──RTSP──►  MediaMTX ──┐
                                 ├──► xem trực tiếp, đọc QR, ghi hình  (GIỮ NGUYÊN)
Webcam USB ─ffmpeg──►  MediaMTX ──┘
```

Ba sự thật đo được trên máy này hôm nay, quyết định hình dạng kế hoạch:

| Đo cái gì | Kết quả | Hệ quả |
|---|---|---|
| ffmpeg đi kèm agent có đọc được USB không | **Có** — hỗ trợ `dshow`, liệt kê được camera đang cắm | Không phải đổi bản ffmpeg |
| Webcam xuất định dạng gì | **Chỉ MJPEG và YUV, tối đa 1280×720** — không có H.264 | **Máy kho BẮT BUỘC phải mã hoá.** Camera IP thì chỉ cần chép thẳng (`-c:v copy`), không tốn CPU |
| Mã hoá 720p30 tốn bao nhiêu | x264 `veryfast` → **1.177 kbps** (≈ 0,53 GB/giờ) | Nhẹ hơn camera IP (1 GB/giờ), nhưng đổi lại là CPU |

Và **một chốt chặn phải phá trước khi làm bất cứ gì khác**: hàm dựng cấu hình relay đang ép mọi nguồn phải là URL `rtsp://`, thấy khác là **ném lỗi**. Camera USB không có URL. Nếu chỉ thêm cột vào database mà không sửa chỗ này thì relay không khởi động lại được, và **mất xem trực tiếp của TẤT CẢ camera trên máy kho đó** — hỏng nặng hơn nhiều so với việc chưa có tính năng.

---

## 1. Hiện trạng (đọc từ mã nguồn)

**Trục "camera ↔ bàn ↔ ghi hình ↔ clip" đã trung lập, không biết camera nối kiểu gì.** Các hàm trong database (`station_camera_ids`, `resolve_scanner_at`, `resolve_station_camera_at`) đều đi qua bảng thiết bị của bàn, không đụng tới IP. Ghi hình đặt tên file theo mã camera. Xem trực tiếp ghép URL từ tên đường dẫn relay. Đọc QR đọc từ relay ở localhost. **Đây là phần lớn hệ thống, và nó không cần sửa.**

**Phần kết nối thì IP từ đầu tới cuối.** Camera được khai bằng IP + cổng + tài khoản + mật khẩu + đường dẫn RTSP; dò tìm bằng quét mạng LAN và ONVIF; định danh bằng MAC; kiểm tra sống chết bằng cách gõ cửa cổng 554; tự tìm lại khi đổi IP. Không có khái niệm nào khác.

**Bảng `cameras` không có câu lệnh tạo bảng trong repo** — bảng gốc dựng thẳng trên Supabase, chỉ các lần thêm cột là có file. Nên **phải xem cấu trúc thật trên database trước khi viết migration**: nhiều khả năng `ip`, `rtsp_port`, `rtsp_path`, `username` đang NOT NULL, và giá trị mặc định (554 / admin / `/ch1/main`) nằm ở tầng JavaScript chứ không ở database.

**Relay MediaMTX bản 1.21.0 có sẵn khả năng nhận luồng đẩy vào** (`source: publisher`) — thực tế mã nguồn đã sinh ra dạng đó làm phương án dự phòng khi kho chưa có camera nào. Chỉ là chưa bao giờ dùng cho một camera cụ thể.

**Chưa kiểm chứng được tại chỗ (25/09):** tôi thử đẩy webcam của máy này vào relay nhưng không đọc lại được — vì relay **chỉ chạy khi có camera đang hoạt động**, mà cả ba camera của kho test đều đang mất kết nối, nên lúc thử không có máy chủ RTSP nào nghe. Đây là việc đầu tiên của đợt 1, không phải kết luận rằng cách làm này hỏng.

---

## 2. Đợt 0 — Ba phép thử phải qua trước khi viết mã (nửa ngày)

Không qua ba phép thử này thì mọi đợt sau là xây trên cát.

| Phép thử | Cách làm | Nếu trượt thì sao |
|---|---|---|
| **A. Dịch vụ Windows có đọc được webcam không** | Agent chạy dưới dạng dịch vụ (session 0). Windows chặn nhiều thiết bị camera với tiến trình không có phiên người dùng, và còn có công tắc quyền riêng tư "Cho phép ứng dụng dùng camera". Chạy `ffmpeg -f dshow -i video="<tên>"` **từ chính dịch vụ**, không phải từ cửa sổ dòng lệnh | Phải cho dịch vụ chạy dưới tài khoản người dùng, hoặc tách một tiến trình phụ chạy trong phiên người dùng. **Đây là rủi ro lớn nhất của cả kế hoạch** |
| **B. Đẩy được vào relay và đọc lại được** | Dựng cấu hình relay có một path `source: publisher`, đẩy webcam vào, rồi đọc bằng ffprobe và xem thử bằng trình duyệt | Phải đổi sang cách ghi thẳng từ `dshow` (mất đường dùng lại xem trực tiếp và đọc QR) |
| **C. Máy kho gánh nổi mã hoá** | Chạy đồng thời số webcam dự định dùng, đo CPU. Máy này: một luồng 720p30 chạy được bằng x264 `veryfast` | Hạ xuống 15 hình/giây, hoặc dùng mã hoá phần cứng (`encode-gate.ts` đã biết chọn QSV/NVENC/AMF) |

**Kết quả ba phép thử ghi vào `plans/reports/` rồi mới sang đợt 1.**

---

## 3. Việc cụ thể theo đợt

### Đợt 1 — Relay nhận webcam (2–3 ngày)

Đây là đợt quan trọng nhất; làm sai là hỏng cả camera IP.

- `live/relay-hub.ts`: kiểu `RelayPath` đổi thành hai nhánh — nguồn RTSP (như cũ) **hoặc** nhận luồng đẩy vào. Hàm chuẩn hoá chỉ kiểm tra giao thức ở nhánh RTSP.
- Sinh cấu hình cho webcam:
  ```yaml
  c<mã_hex>m:
    runOnDemand: ffmpeg -f dshow -rtbufsize 256M -i video="<tên thiết bị>"
                 -c:v libx264 -preset veryfast -tune zerolatency -g 60 -an
                 -f rtsp rtsp://127.0.0.1:8554/$MTX_PATH
    runOnDemandRestart: yes
    runOnDemandCloseAfter: 10s
  ```
  Tên thiết bị đi qua biến môi trường như credential camera IP đang làm, không ghi vào file cấu hình.
- Chỗ dựng danh sách path rẽ nhánh theo loại camera; camera thiếu URL RTSP **không được làm ném lỗi cả hàm**.
- **Chốt an toàn bắt buộc:** thêm bài test cho hàm dựng cấu hình với một camera USB + một camera IP cùng lúc, và một bài canh "camera USB lỗi không làm hỏng path của camera IP".

### Đợt 2 — Khai báo camera USB (2–3 ngày)

- **Database:** thêm `transport_kind` (`ip` | `usb`, mặc định `ip` để dữ liệu cũ không đổi), `usb_device_name`, `usb_device_path`. Nới NOT NULL cho các cột IP, hoặc thêm ràng buộc "là camera IP thì phải đủ IP/cổng/đường dẫn". **Xem cấu trúc thật trên database trước.**
- Khoá duy nhất `(agent_id, usb_device_path)` cho camera USB — một webcam không được khai hai lần.
- **Định danh theo đường dẫn thiết bị, KHÔNG theo tên.** Hai webcam cùng model có tên hiển thị giống hệt nhau; đường dẫn thiết bị (`@device_pnp_\\?\usb#vid_30c9&pid_0069&...`) mới phân biệt được. Đây đúng bài học MAC của camera IP: định danh theo thứ không đổi, không theo thứ người dùng nhìn thấy.
- **Lệnh mới cho agent:** liệt kê webcam đang cắm (`ffmpeg -list_devices true -f dshow -i dummy`), trả về tên + đường dẫn thiết bị. Nhớ nới ràng buộc loại lệnh trong database — đã có tiền lệ quên bước này làm lệnh không xuống được agent.
- **Giao diện:** đầu form thêm lựa chọn "Camera IP / Camera USB". Chọn USB thì ẩn và bỏ bắt buộc sáu ô IP/cổng/tài khoản/mật khẩu/đường dẫn, thay bằng chọn máy kho + chọn thiết bị từ danh sách quét được.
- Chỗ nhận dạng camera trong giao diện đang **lấy IP làm khoá** — phải đổi sang mã camera.

### Đợt 3 — Ghi hình, kiểm tra sống chết (2 ngày)

- **Ghi hình:** vì webcam đã nằm trong relay, ghi hình chỉ cần đọc `rtsp://127.0.0.1:8554/<đường_dẫn>` — giữ nguyên `-c:v copy`, giữ nguyên cách cắt 60 giây. **Đây là cách ít thay đổi nhất**, và tránh được chuyện tham số RTSP không hợp lệ với nguồn USB.
- **Kiểm tra sống chết:** camera USB không có cổng để gõ cửa. Thay bằng: thiết bị còn trong danh sách đang cắm không, và relay có luồng không. Nếu không sửa, camera USB sẽ **báo Offline vĩnh viễn** và bắn cảnh báo mất kết nối sai.
- **Tự tìm lại khi đổi IP:** bỏ qua hẳn camera USB.
- **Phân loại lỗi:** các mẫu lỗi hiện tại là mã lỗi RTSP (401, 404). Lỗi của webcam đọc khác hẳn ("Could not find video device", "device or resource busy") và hiện sẽ bị coi là lỗi tạm thời rồi thử lại vô hạn.
- **Kiểm tra kết nối** từ giao diện: camera USB phải đi qua agent (cloud không có webcam), không chạy ffmpeg tại cloud như camera IP.

### Đợt 4 — Dọn các chỗ nói sai (1–2 ngày)

- Che thông tin nhạy cảm: đang che IP/cổng/tài khoản bằng dấu chấm. Camera USB không có mấy thứ đó — hiện "••••" là nói dối người xem.
- Gán camera vào máy kho: camera IP gán theo kết quả quét LAN; camera USB phải gán theo **máy đang cắm nó**. Kho có từ hai máy trở lên mà không sửa thì camera USB thành mồ côi, không máy nào dựng luồng.
- Nhật ký thay đổi camera, danh sách trường làm mất hiệu lực bản ghi codec: thêm các trường USB.

---

## 4. Giới hạn vật lý của camera USB — nói trước để không kỳ vọng sai

| Giới hạn | Con số | Ý nghĩa với kho |
|---|---|---|
| Chiều dài cáp | **5 m** (USB 2.0), xa hơn cần bộ lặp/cáp quang | Camera IP đi được 100 m cáp mạng. Webcam chỉ đặt được ngay tại bàn |
| Băng thông chung một cổng | MJPEG 720p30 ≈ 25–40 Mbps mỗi camera; một bộ điều khiển USB 2.0 chỉ có 480 Mbps và chia cho mọi cổng | Cắm 3–4 webcam vào cùng một máy dễ rớt hình. Phải thử thật, không suy luận |
| Nguồn điện | Lấy từ máy tính | Máy sập là mất hết camera của bàn đó, không như camera IP có nguồn riêng |
| Chất lượng | Webcam phổ thông tối đa 1080p, không có ống kính đổi được, kém trong thiếu sáng | Bàn đọc mã QR nhỏ (nhãn TikTok) nên cân nhắc kỹ — xem bản cam kết cỡ mã trong `warehouse-agent/tests/qr-size-commitment.test.ts` |
| Cắm sang cổng khác | Đường dẫn thiết bị **đổi** | Phải có cách khai báo lại nhanh, và báo cho người dùng biết vì sao camera "biến mất" |

**Khuyến nghị:** dùng webcam cho bàn phụ, bàn tạm, hoặc kho nhỏ một bàn — nơi không kéo được dây mạng. Bàn chính vẫn nên dùng camera IP.

---

## 5. Rủi ro và cách chặn

| Rủi ro | Hậu quả | Chặn bằng |
|---|---|---|
| Sửa relay làm hỏng camera IP | **Mất xem trực tiếp toàn kho** | Test dựng cấu hình với cả hai loại camera cùng lúc, chạy trước khi đụng vào máy thật |
| Dịch vụ Windows không mở được webcam | Tính năng không chạy được ở kho, dù chạy tốt trên máy lập trình | Phép thử A ở đợt 0, làm trước mọi thứ |
| Mã hoá ăn hết CPU, ảnh hưởng ghi hình camera IP | Mất đoạn video của camera khác | Phép thử C; đặt trần số camera USB mỗi máy; ưu tiên mã hoá phần cứng |
| Camera USB báo Offline sai | Cảnh báo mất kết nối bắn liên tục, người dùng mất tin vào cảnh báo | Đợt 3 sửa cách kiểm tra sống chết trước khi bật cho kho thật |
| Nới NOT NULL sai cách | Camera IP tạo mới thiếu IP mà không ai chặn | Dùng ràng buộc theo loại, không chỉ bỏ NOT NULL |

---

## 6. Không làm trong kế hoạch này

- **Không hỗ trợ webcam gắn vào máy khác trong mạng** (kiểu chia sẻ USB qua mạng). Nếu kéo được dây mạng thì dùng camera IP, rẻ và ổn định hơn.
- **Không tự dò webcam định kỳ.** Chỉ quét khi người dùng bấm thêm camera.
- **Không đổi gì ở đường camera IP.** Mọi thay đổi đều là thêm nhánh, giá trị mặc định giữ nguyên là `ip`.
- **Không hứa đọc được mã QR nhỏ bằng webcam.** Bản cam kết cỡ mã hiện tại đo trên camera 2K; webcam 720p ở cùng tầm nhìn cho **chưa tới một nửa** số điểm ảnh. Phải đo lại riêng nếu bàn đó cần đọc mã.

---

## 7. Câu hỏi cần chủ dự án trả lời trước đợt 1

1. **Webcam dùng cho việc gì?** Chỉ ghi hình toàn cảnh làm bằng chứng, hay cũng phải đọc mã QR? Nếu phải đọc mã thì phải đo lại cỡ mã đọc được với webcam thật.
2. **Mỗi máy kho dự kiến bao nhiêu webcam?** Quyết ngưỡng CPU và cách chia cổng USB.
3. **Có model webcam nào đã mua chưa?** Có model cụ thể thì đo đúng model đó, không đo bằng webcam của máy lập trình.
