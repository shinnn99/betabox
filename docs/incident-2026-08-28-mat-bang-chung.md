# Sự cố 27/08–04/09/2026 — kho Đại Kim mất bằng chứng ghi hình

Trạng thái: **đã hết sự cố, đang bịt nguyên nhân gốc.**
Người viết: Betacom. Ngày: 09/09/2026.

---

## Chuyện gì đã xảy ra

Camera `dahua_01` ở kho Đại Kim ngừng nhận kết nối ghi hình từ **14:25 ngày
27/08**. Hệ thống thử kết nối lại đều đặn 5 phút một lần, liên tục trong 8
ngày, nhưng camera từ chối. Ghi hình chạy lại lúc **15:39 ngày 04/09**.

Trong khoảng đó, kho vẫn làm việc bình thường. Ngày có thiệt hại lớn nhất là
**28/08: 79 đơn được đóng gói mà không có video kèm theo.**

Khoảng còn lại rơi đúng vào lúc kho gần như không hoạt động: 29/08 chỉ 2 đơn,
từ 30/08 đến 03/09 kho nghỉ hẳn (0 đơn), 04/09 có 22 đơn nhưng ghi hình đã chạy
lại trước đó. Nhờ vậy thiệt hại tập trung gần như toàn bộ vào ngày 28/08.

## Ảnh hưởng cụ thể tới khách

- **79 đơn ngày 28/08 không có clip bằng chứng.** Nếu có tranh chấp về một
  trong các đơn đó, hệ thống không cung cấp được video.
- **Không mất dữ liệu đơn hàng.** Mã đơn, thời gian quét, người đóng gói —
  còn nguyên. Chỉ thiếu phần video.
- **Các ngày khác không ảnh hưởng.** Đo lại toàn bộ 5 tuần gần nhất: ngoài
  ngày 28/08, không ngày nào có đơn mất bằng chứng.
- **Từ 04/09 tới nay ghi hình chạy bình thường**, đã kiểm tới ngày 09/09.

## Vì sao không ai phát hiện sớm

Đây là phần Betacom nhận trách nhiệm.

Hệ thống tự kiểm hạ tầng được dựng ngày 12/08 và **có sẵn đúng mục kiểm bắt
được sự cố này**. Nhưng bộ hẹn giờ chạy nó chưa bao giờ được kích hoạt trên
máy chủ — nó chạy 7 lần trong hai ngày dựng rồi dừng hẳn.

Hệ thống được thiết kế theo nguyên tắc "không có tin nhắn nghĩa là mọi thứ
bình thường". Khi chính bộ tự kiểm chết, nó không gửi gì — và trông y hệt như
lúc mọi thứ đều ổn. Đó là lý do 8 ngày trôi qua mà không ai biết.

Nói ngắn gọn: **công cụ phát hiện đã có, nhưng chưa được bật.**

## Đã và đang làm gì để không lặp lại

1. **Bật bộ tự kiểm chạy 15 phút/lần**, kiểm tra bằng bản ghi thật trong cơ sở
   dữ liệu chứ không tin trạng thái báo cáo của máy chủ.
2. **Cảnh báo khi ghi hình ngừng** — gửi tin ngay khi kho vẫn đóng gói mà
   không có video mới quá 10 phút, mức nghiêm trọng ở 20 phút.
3. **Cảnh báo khi chính bộ tự kiểm chết** — dùng dịch vụ giám sát độc lập bên
   ngoài máy chủ, nên nó sống sót kể cả khi máy chủ sập. Đây là thứ đáng lẽ
   phải có từ đầu.
4. **Thông báo khi sự cố kết thúc**, để phân biệt "đã khắc phục" với "vẫn hỏng
   nhưng tin bị nén".

Tất cả được nghiệm thu bằng 8 bài kiểm tra thực tế — gồm cả việc chủ động tắt
ghi hình, tắt camera, và tắt chính bộ cảnh báo để xem có nhận được tin không.

## Cần gì từ phía kho

Không cần thao tác gì. Nhưng nếu tiện, hai việc giúp giảm rủi ro:

- **Nguồn điện.** Máy kho mất điện đột ngột 5 lần trong 5 ngày đầu tháng 8.
  Một bộ lưu điện (UPS) nhỏ sẽ tránh hỏng file video đang ghi dở.
- **Báo sớm khi thấy bất thường.** Nếu nhân viên thấy camera mất hình trên
  màn hình, báo ngay — kênh trực tiếp vẫn nhanh hơn mọi hệ thống tự động.

---

*Nếu cần trích xuất video cho bất kỳ đơn nào ngoài 79 đơn ngày 28/08, hệ thống
vẫn phục vụ bình thường theo thời hạn lưu trữ 30 ngày.*
