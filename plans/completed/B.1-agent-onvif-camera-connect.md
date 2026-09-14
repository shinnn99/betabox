### [B.1] - Agent ONVIF và camera connect

- **Mục tiêu:** Tự động lấy main/sub stream qua ONVIF và fallback các RTSP path phổ biến mà không làm lộ credential.
- **Files tạo/sửa:** `warehouse-agent/src/onvif-auth.ts`, `warehouse-agent/src/camera-connect.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/tests/camera-connect.test.ts`.
- **Đã thực hiện:** WS-UsernameToken PasswordDigest; Device/Media SOAP flow; chọn main/sub profile; fallback RTSP theo thứ tự; ffmpeg frame probe có timeout; dừng ngay khi sai tài khoản; kết quả trả cloud đã loại credential.
- **Kiểm tra:** `npm run typecheck` pass; `npm test` pass 70/70.
- **Trạng thái:** Đã hoàn thành
