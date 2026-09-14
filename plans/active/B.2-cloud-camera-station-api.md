### [B.2] - Cloud API thiết lập camera theo bàn

- **Mục tiêu:** Hoàn thiện bước 5 theo `docs/tuan-tu-xu-ly-2-camera.md`.
- **Files dự kiến tạo/sửa:** API camera theo bàn; API packing station; station device/assignment; scan/manual scan; camera discovery; codec invalidation; command enqueue/poll/result; camera service và migration hỗ trợ nếu cần.
- **Chi tiết cần hoàn thành:** Kết nối qua đúng agent của bàn; credential chỉ xuất hiện trong response HMAC vào RAM agent; finalize camera/role/assignment sau callback thành công; xác nhận chuyển bàn; scanner ảo `qrcam_<camera_code>` cho QR camera; scan sai nguồn vẫn lưu raw nhưng không tạo session/đơn; đổi scan source có audit và chỉ cho camera khi QR camera đã kết nối.
- **Trạng thái:** Đang xử lý
