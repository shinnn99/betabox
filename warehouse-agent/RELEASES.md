# Lịch sử phiên bản — Betacom Warehouse Agent

Ghi từ 0.8.6 trở đi. Mỗi mục nêu: sửa gì, vì sao, và người đi cài cần biết gì.

---

## 0.8.7 — 2026-08-05

**Camera "Tạm ngưng" trên dashboard giờ thật sự dừng ghi.**

Trước bản này, chuyển camera sang Tạm ngưng chỉ đổi nhãn trên cloud — agent
không hề nhận được tín hiệu nào và vẫn spawn ffmpeg mỗi 5 phút, mãi mãi.
Camera hik_01 kho Đại Kim kẹt như vậy từ 24/07 đến 05/08 (khoảng 78 lần thử
ghi mỗi ngày), và người dùng không có cách nào dừng qua giao diện.

Thay đổi:

- Agent đối chiếu desired với danh sách camera active của cloud mỗi 30 giây.
  Camera không còn trong danh sách → dừng ffmpeg, xóa desired, xóa timer
  retry, báo cloud. Có hiệu lực **kể cả khi camera đang ghi bình thường**.
- Mất mạng **không** bị hiểu nhầm là thu hồi: chỉ thu hồi khi request tới
  cloud thành công mà camera vắng mặt trong kết quả.

**Đi kèm bản cloud cùng ngày** (phải deploy cloud trước khi cài agent này):
nút Dừng ghi hiện cả khi session đang lỗi; API dừng không còn trả 409 khi
không có gì để dừng; bấm dừng nhiều lần không tạo lệnh trùng.

Người đi cài cần biết: cài đè như thường lệ, không mất cấu hình. Nên cài vào
lúc camera không ghi nếu sắp xếp được — quá trình cài dừng dịch vụ khoảng
20 phút nếu thao tác thủ công (lần cài 0.8.6 sáng 05/08 mất 22 phút, không
ghi được trong khoảng đó).

---

## 0.8.6 — 2026-08-05

**Camera không còn tự chết im, và máy kho không còn tự ngủ.**

- Sửa phân loại lỗi: agent từng đọc nhầm dãy số trong log ffmpeg thành mã
  lỗi 401/404 và kết luận camera hỏng vĩnh viễn, rồi bỏ ghi luôn. Camera
  Dahua dính nặng vì bơm log "Non-monotonic DTS" liên tục.
- Không xóa ý định ghi vì lỗi lúc chạy nữa. Tắt máy cuối ca là chuyện bình
  thường của kho — hệ phải tự ghi lại khi bật máy, không đợi ai bấm tay.
- Installer tắt Sleep/Hibernate của máy kho. Máy tự ngủ làm đóng băng cả
  agent lẫn ffmpeg mà không để lại dấu vết trong log; đo được các lần ngủ
  từ 19 phút đến 38,9 giờ, khớp từng khoảng trống video.
