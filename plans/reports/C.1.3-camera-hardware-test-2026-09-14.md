# Báo cáo kiểm thử camera thật C.1.3 — 2026-09-14

## Phạm vi

- Kiểm tra khả năng truy cập hai camera LAN do người dùng cung cấp để chuẩn bị probe codec, relay MediaMTX và giải mã QR.
- Credential chỉ được đưa vào biến của tiến trình test, không ghi vào file dự án hay `.env.local`.

## Kết quả

| Thiết bị | Kết nối LAN | TCP/RTSP 554 | Probe codec/frame/QR |
| --- | --- | --- | --- |
| Hikvision test | Web live hoạt động; IP cập nhật sang `.135` | Thành công: H.264, 1280×720, 25 FPS | Direct: 20/20 frame decode đạt, không thấy QR; MediaMTX: lỗi source, 0 frame |
| Dahua test | Ping thành công | Không kết nối | Chưa thể chạy |

Máy kiểm thử có địa chỉ trong cùng dải `192.168.31.x`. Với IP Hikvision mới, FFprobe ngoài sandbox đã xác nhận URL và credential test có thể mở stream. FFmpeg lấy thành công frame xám 640×360: một frame đúng 230.400 byte và đủ 20 frame ở 2 FPS trong 10 giây. Lỗi nạp decoder ban đầu là interop của harness Node 24 + `tsx -e`; gọi export qua `default` đã xử lý đủ 20/20 frame, không phát hiện QR trong cảnh tại thời điểm test.

Smoke test tiếp theo sử dụng đúng `RelayHub`, MediaMTX đóng gói, `QrFrameSource` và decoder. MediaMTX không áp dụng source RTSP được truyền qua biến môi trường cho path cấu hình, nên coi path là `publisher` và thoát với lỗi `sourceOnDemand is useless when source is publisher`. Supervisor restart lặp; `QrFrameSource` nhận 0 frame. Đây là lỗi của đường relay production, không phải camera hoặc harness.

## Kết quả sau C.1.1-FIX

- Nguyên nhân được xác nhận là tên path chứa `_`, không tương thích cách MediaMTX v1.21 phân tách map key trong biến môi trường.
- Path mới dùng chữ-số thuần, ổn định từ mã camera và loại stream.
- MediaMTX khởi động đủ RTSP/WebRTC listener và kéo nguồn H.264 on-demand.
- `QrFrameSource` và decoder xử lý 21/21 frame qua relay localhost; không thấy QR trong cảnh tại thời điểm test.
- File YAML sinh ra không chứa URL, username hoặc password camera.
- Startup cấu hình lỗi trả lỗi cho caller và không còn restart vô hạn.

## Điều kiện để chạy lại

- Đưa một QR thật vào vùng nhìn Hikvision để xác nhận phát hiện trên camera thật.
- Mở/kiểm tra RTSP Dahua và chạy cùng smoke test.
- Thực hiện replay video kho ba ngày theo tiêu chí nghiệm thu C.1.3.
- Cho phép cổng RTSP qua cấu hình mạng/firewall của camera.

Sau khi cổng RTSP truy cập được, chạy lại theo thứ tự: FFprobe an toàn → relay MediaMTX localhost → trích frame xám → QR decode 10 giây không tạo đơn.

## Trạng thái

**Bị chặn bởi kết nối thiết bị.** C.1.3 vẫn nằm trong `plans/active`; không đánh dấu hoàn thành.
