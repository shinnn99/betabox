# C.1.1 — MediaMTX local relay

**Trạng thái:** Đã hoàn thành sau sửa lỗi từ kiểm thử camera thật

## Kết quả

- MediaMTX v1.21.0 relay on-demand chỉ mở RTSP/WebRTC trên `127.0.0.1`; các giao thức và dịch vụ không dùng tiếp tục bị tắt.
- Tên path dùng encoding chữ-số thuần tương thích cơ chế map-key environment của MediaMTX; main/sub dùng cùng helper nên không lệch đường dẫn.
- URL camera có credential chỉ tồn tại trong environment tiến trình con; file cấu hình và log không chứa credential.
- `RelayHub.reconcile()` chỉ thành công sau khi cả RTSP lẫn WebRTC listener sẵn sàng.
- Cấu hình lỗi trước readiness được trả về caller và không tạo vòng restart vô hạn; crash sau readiness vẫn được supervisor restart.
- Recording hiện hữu tiếp tục đọc trực tiếp từ camera; không thay đổi template UI.
- Theo yêu cầu người dùng, không build agent `.exe` hoặc installer mới.

## Kiểm tra

- `npm run typecheck` trong `warehouse-agent`: đạt.
- `npm test` trong `warehouse-agent`: 88/88 đạt, gồm integration test binary MediaMTX với source từ environment và startup failure.
- `pnpm typecheck` tại root: đạt.
- ESLint tất cả file sửa: đạt.
- Smoke test Hikvision thật qua MediaMTX → `QrFrameSource` → decoder: 21/21 frame đạt; credential không nằm trong YAML.
- Credential leak scan: sạch; tiến trình và cổng test đã được dọn sạch.
