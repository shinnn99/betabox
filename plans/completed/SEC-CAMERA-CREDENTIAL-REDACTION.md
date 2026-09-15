# SEC-CAMERA-CREDENTIAL-REDACTION — Bảo vệ credential camera

## Phạm vi đã thực hiện

- Giữ nguyên cách kết nối camera của hệ thống cũ: admin nhập cấu hình trên UI, password được mã hóa trước khi lưu và chỉ được giải mã tạm thời trong RAM khi backend cấp cho đúng Agent.
- Không thay đổi UI, cơ chế ánh xạ camera–agent–bàn hoặc quy trình vận hành camera.
- Sửa redaction để che toàn bộ RTSP userinfo (`username:password@`), kể cả URL nằm trong FFmpeg stderr.
- Bổ sung regression test ở cả backend và Warehouse Agent.
- Xóa file scratch có URL credential dạng plaintext và làm sạch log Agent cũ.
- Khởi động lại Agent nguồn; MediaMTX và hai tiến trình FFmpeg hoạt động, log mới không chứa credential chưa che.

## Kiểm tra

- Root test: 339/339 đạt.
- Warehouse Agent test: 89/89 đạt.
- Root và Warehouse Agent typecheck: đạt.
- ESLint các file liên quan: 0 lỗi.
- Quét log runtime: 0 RTSP userinfo chưa che.
- Không có biến test `RTSP_URL_HIKVISION`, `RTSP_URL_DAHUA` hoặc `RTSP_URL` trong workspace ngoài các thư mục dependency/build đã loại trừ.

## Trạng thái

Đã hoàn thành.
