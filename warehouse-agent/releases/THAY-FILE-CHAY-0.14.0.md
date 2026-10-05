# Thay file chạy lên 0.14.0 (không cần bộ cài)

Bản 0.14.0 chỉ đổi **một file chạy**: không thêm file mới, không đổi `.env`,
không cần chạy migration. Thay thẳng file là đủ.

File: `betacom-agent-0.14.0.exe` (65 MB, lưu qua Git LFS).

```powershell
git lfs pull --include "warehouse-agent/releases/betacom-agent-0.14.0.exe"
```

Hoặc chép qua USB / ổ mạng từ máy lập trình.

## Bản này thêm gì

**Máy kho báo riêng dung lượng thư mục video.**

Trước nay máy kho chỉ khai tổng ổ và phần còn trống. Hai con số đó nói được
"ổ sắp đầy chưa", nhưng không nói được trong phần đã dùng thì **video chiếm
bao nhiêu** — phần còn lại là Windows và phần mềm khác trên cùng ổ. Không biết
tỷ lệ đó thì cũng không đặt được số ngày lưu cho vừa ổ.

Bản này đo riêng thư mục lưu video và gửi lên cùng nhịp với các số khác. Phép
đo cộng **toàn bộ** dữ liệu thực có trong thư mục đó, nên không bỏ sót file
tạm hay dữ liệu lạ cũng đang chiếm chỗ.

Để không làm máy kho quét ổ liên tục, số này đo lại **tối đa mỗi giờ** — nên
có thể chậm hơn thực tế khoảng một giờ. Trang hiển thị có ghi rõ điều đó.

**Không đổi gì ở phần ghi hình.** Ngưỡng cảnh báo ổ đầy và luật dọn theo số
ngày lưu giữ y nguyên như 0.13.2. Phép đo mới chỉ để báo cáo, không tham gia
quyết định xoá file.

## Các bước trên máy kho

Mở **PowerShell với quyền quản trị** (chuột phải → Run as administrator):

```powershell
# 1. Dừng dịch vụ
Stop-Service BetacomAgent

# 2. Giữ lại bản cũ để còn đường lùi
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" -Force

# 3. Chép bản mới đè lên (sửa đường dẫn nguồn cho đúng chỗ bạn để file)
Copy-Item "D:\betacom-agent-0.14.0.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force

# 4. Chạy lại
Start-Service BetacomAgent
Get-Service BetacomAgent
```

## Kiểm lại ngay sau khi chạy

1. Mở trang **Platform → Đội agent**, trong vòng 1 phút máy kho phải hiện
   phiên bản **0.14.0**.
2. Mở trang **Dung lượng lưu trữ** của kho đó. Ô **"Thư mục lưu video"** phải
   hiện một con số, không còn gạch ngang kèm lời nhắc cập nhật.
3. Con số đó phải **nhỏ hơn hoặc bằng** phần "Đã sử dụng" của ổ. Lớn hơn là
   sai — báo lại.

Lưu ý: ngay sau khi khởi động lại dịch vụ, ô này có thể còn trống một lát vì
phép đo chạy theo nhịp. Chờ qua một lượt tự kiểm rồi xem lại.

## Nếu phải lùi lại

```powershell
Stop-Service BetacomAgent
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force
Start-Service BetacomAgent
```

An toàn: không có thay đổi nào ở database hay giao thức. Lùi về 0.13.2 thì ô
"Thư mục lưu video" quay lại trạng thái gạch ngang, mọi thứ khác như cũ.

## Bản này có gì

Xem [../RELEASES.md](../RELEASES.md) mục 0.14.0.
