# Lịch sử phiên bản — Betacom Warehouse Agent

Ghi từ 0.8.6 trở đi. Mỗi mục nêu: sửa gì, vì sao, và người đi cài cần biết gì.

---

## 0.8.9 — 2026-08-11

**Đơn không còn kẹt "Đang cắt" vĩnh viễn khi agent báo kết quả không tới
được cloud.**

Chuyện xảy ra hôm 11/08 ở kho Đại Kim: máy kho có lúc gọi nhầm sang bản
cloud cũ đã ngừng hoạt động (do đổi máy chủ, DNS chưa cắt hẳn), nên lời
báo "cắt clip xong/lỗi" của agent rơi mất giữa đường. Lệnh cắt đã được
ghi nhận là hỏng, nhưng ô trạng thái của đơn vẫn quay "Đang cắt" mãi và
không có cả nút Thử lại. Đơn SPXVN068642901568 kẹt như vậy.

Bản này thêm **hộp thư đi**: lời báo nào không gửi được thì agent ghi
xuống ổ đĩa và gửi lại mỗi phút cho tới khi cloud nhận — sống qua cả
việc khởi động lại máy. Lời báo bị cloud từ chối vì sai nội dung (chứ
không phải lỗi đường truyền) thì bỏ ngay, không gửi lại vô ích, và ghi
rõ vào log.

**Đi kèm bản cloud cùng ngày** (nên deploy cloud trước): cloud tự đóng
trạng thái clip khi nhận được báo lỗi của lệnh cắt, và tự dọn những clip
kẹt quá 5 phút mà không còn lệnh cắt nào đang chạy. Ba lớp này độc lập
nhau — thủng lớp nào vẫn còn lớp sau đỡ.

Người đi cài cần biết: cài đè như thường lệ, không mất cấu hình, không
đổi cách agent nói chuyện với cloud. Có thêm một file hàng đợi mới trong
thư mục `data` (`pending-clip-results.jsonl`) — bình thường nó rỗng.

---

## 0.8.8 — 2026-08-07

**Clip quá nặng giờ báo rõ lý do thay vì lỗi khó hiểu, và đơn chưa đóng
không còn bị cắt clip cụt.**

Hai chuyện xảy ra trước bản này:

1. Mở màn hình xem video lúc nhân viên **chưa đóng xong đơn** thì hệ vẫn
   cắt clip ngay. Lúc đó chưa biết đơn kết thúc khi nào nên clip chỉ lấy
   60 giây mặc định — và bản cụt đó được lưu làm bằng chứng chính thức.
   Đã xảy ra thật ở kho Đại Kim: một đơn dài 3 phút chỉ còn clip 70 giây.
   Giờ màn hình báo "Đơn đang được đóng gói, clip đầy đủ sẽ có sau khi
   đơn kết thúc" và tự cắt khi đơn đóng — người dùng không phải bấm lại.

2. Clip vượt dung lượng cho phép tải lên thì agent cứ tải rồi mới hỏng,
   và khách chỉ thấy "Cắt clip thất bại" không rõ nguyên nhân. Giờ agent
   đo file trước khi tải; quá cỡ thì dừng và báo rõ nặng bao nhiêu, dài
   bao nhiêu, so với giới hạn nào.

**Đi kèm bản cloud cùng ngày** (deploy cloud trước khi cài agent): màn
hình Giám sát hiện cảnh báo trước cho những đơn có nguy cơ không tạo
được video đầy đủ.

Người đi cài cần biết: cài đè như thường lệ, không mất cấu hình, không
đổi cách agent nói chuyện với cloud. Đây là bản sửa lỗi, không thêm chức
năng mới.

**Việc cần theo dõi sau khi cài** — quan trọng: đo ngày 07/08 cho thấy
camera kho Đại Kim đang ghi ở mức nặng tới ngưỡng. Trong 131 đơn kéo dài
quá 3 phút gần đây, khoảng **27 đơn (21%)** sẽ không tạo được video bằng
chứng vì file vượt giới hạn tải lên, và gần như toàn bộ số còn lại chỉ
còn dưới 1 MiB dự phòng. Bản này **không sửa được** chuyện đó — nó chỉ
làm cho lỗi hiện ra rõ ràng thay vì im lặng. Cách sửa là hạ mức ghi của
camera, đang xử lý riêng.

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
