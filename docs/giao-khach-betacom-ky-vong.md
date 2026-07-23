# Hệ thống bằng chứng đóng hàng Betabox — hướng dẫn dùng

**Dành cho:** [Anh/Chị TRƯỞNG KHO]
**Người bàn giao:** [Hạnh — SĐT: __________]
**Ngày bàn giao:** ____/____/2026

---

## 1. Betabox làm gì

Ghi lại video mỗi lần nhân viên đóng và quét mã đơn hàng. Khi có tranh chấp với khách hoặc sàn, mở dashboard tìm mã đơn → xem lại clip video → có bằng chứng khách quan.

**Kịch bản thường gặp:** khách khiếu nại "đơn thiếu hàng" → Betabox có clip nhân viên quét mã đơn đó + đóng gói + dán tem → gửi clip cho sàn/khách → thắng khiếu nại.

---

## 2. Ba điều KHÔNG PHẢI Betabox (tránh hiểu nhầm)

**Betabox KHÔNG có AI** phân tích hình. Không tự phát hiện nhân viên gian lận. Không cảnh báo bất thường. Chỉ ghi hình + cắt clip theo lệnh.

**Betabox KHÔNG in mã đơn lên video.** Mã đơn hiển thị ở **panel dashboard bên cạnh video** (thấy song song lúc xem). Trong clip, mã đơn thấy được vì **nhân viên giơ mã lên trước camera lúc quét** — camera ghi lại cảnh đó.

**Betabox KHÔNG lưu video vĩnh viễn trên cloud.** Video segment gốc lưu **30 ngày** trên ổ máy kho, tự xóa sau đó. Clip đã cắt lưu 72 giờ trên cloud, cần lâu hơn thì tải về máy.

---

## 3. Ba việc trưởng kho làm hàng ngày

### 3.1. Kiểm dashboard vào ca sáng (1 phút)

Mở https://betabox.vercel.app/dashboard

Nhìn phần **Máy trạm kho**:
- Xanh "Online" = OK, agent kết nối.
- Đỏ "Offline" = báo [Hạnh] ngay.

Nhìn phần **Thiết bị kho > Cameras**:
- Camera nào đỏ "Offline" = kiểm điện + mạng camera đó, hoặc báo [Hạnh].

### 3.2. Khi khách khiếu nại — tìm clip bằng chứng

1. Mở https://betabox.vercel.app/dashboard/videos
2. Tìm mã vận đơn (dán vào ô Search).
3. Bấm vào dòng đơn → clip mở ra.
4. Video gốc từ camera + panel dashboard bên cạnh có mã đơn + thời gian đóng.
5. Tải clip về máy (bấm Download) → gửi cho sàn/khách qua email/Zalo.

### 3.3. Khi clip lỗi (video đen, không cắt được)

Trong ô clip có nút **[Thử lại]** — bấm 1 lần. Đợi 30 giây. Nếu vẫn lỗi → báo [Hạnh].

Không tự bấm [Thử lại] nhiều lần liên tiếp — không giúp gì mà tốn tài nguyên.

---

## 4. Ba lỗi hay gặp — trưởng kho tự xử được

| Triệu chứng | Nguyên nhân thường | Cách xử |
|---|---|---|
| Dashboard báo "Máy trạm offline" | Máy kho tắt hoặc mất mạng | Kiểm máy còn bật + mạng còn không. Bật lại nếu tắt. |
| Camera "Offline" trên dashboard | Camera mất điện hoặc rớt mạng LAN | Kiểm dây điện + dây mạng camera đó. Cắm lại. |
| Clip "Không có video trong khoảng này" | Camera lúc đó không ghi được (mất điện/mạng) | Không phải lỗi hệ. Ghi nhận với khách "camera thời điểm đó gián đoạn". |

**Ngoài 3 lỗi trên — báo [Hạnh] ngay, đừng tự sửa.** Nhất là: đừng tắt/khởi động lại service `BetacomAgent` trong `services.msc`, đừng xóa file trong `C:\Program Files\BetacomAgent\`, đừng đổi cấu hình camera qua web camera.

---

## 5. Quy tắc vận hành cứng

**Không tắt máy kho ngoài giờ đã thống nhất.** Máy tắt = camera không ghi. Nếu cần tắt (đêm tiết kiệm điện), phải nói trước với [Hạnh] và ghi rõ thời gian nghỉ ghi hình.

**Không cắm thêm phần mềm quản lý camera khác** (Hikvision iVMS, EZVIZ Studio, v.v.) lên máy đang chạy BetacomAgent. Hai phần mềm cùng đọc camera có thể gây xung đột.

**Không đưa quyền Admin máy kho cho người ngoài** — nhân viên IT sàn, kỹ thuật viên mạng, v.v. Nếu cần cho ai vào máy, gọi [Hạnh] trước.

---

## 6. Cửa sổ khiếu nại — hiện tại **30 ngày**

Video segment gốc giữ **30 ngày trên ổ máy kho**. Sau 30 ngày, hệ tự xóa để giải phóng ổ.

Nếu khách khiếu nại đến muộn hơn 30 ngày sau đơn giao — hệ trả "Video đã quá hạn lưu trữ", không cắt được clip.

**Muốn đổi số ngày:** vào https://betabox.vercel.app/dashboard/settings/warehouse-config → mục "Thời gian lưu video" → nhập số → Lưu. Chỉ owner tổ chức đổi được. Hỏi [Hạnh] trước khi đổi vì phải cân với dung lượng ổ.

---

## 7. Số liên hệ khi hỏng

**[Hạnh — SĐT: __________]** (giờ hành chính 8:00-18:00)

Ngoài giờ: gọi cùng số, để lại tin nhắn nếu không bắt máy.

Khi gọi, chuẩn bị 3 thông tin trước để [Hạnh] chẩn đoán nhanh:
1. **Thời điểm** sự cố (giờ, ngày).
2. **Triệu chứng** cụ thể (dashboard báo gì, ô nào đỏ).
3. **Máy kho có bật không, có mạng không** (thử ping google.com từ CMD máy kho).

---

## 8. Nhận bàn giao

Trưởng kho đã xem demo bàn giao trực tiếp gồm:

- [ ] Mở dashboard, đăng nhập.
- [ ] Kiểm phần Máy trạm + Cameras xanh/đỏ.
- [ ] Tìm 1 đơn thật trong `/dashboard/videos`, cắt clip xem.
- [ ] Bấm [Thử lại] một lần cho biết cảm giác.
- [ ] Tải 1 clip về máy.

**Cam kết đã đọc + hiểu 8 mục trên:**

Trưởng kho ký: ______________________ Ngày: ___/___/2026

Người bàn giao (Hạnh) ký: ______________________ Ngày: ___/___/2026

---

*Phiên bản 1.0 — 2026-07-22. Nếu Betabox cập nhật hệ hoặc quy trình đổi, sẽ có phiên bản mới thay thế bản này.*
