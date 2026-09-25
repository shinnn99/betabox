# Thay file chạy lên 0.12.1 (không cần bộ cài)

Bản 0.12.1 chỉ đổi **một file chạy**: không thêm file mới, không đổi cấu
hình, không đổi cách nói chuyện với hệ thống. Thay thẳng file là đủ.

File: `betacom-agent-0.12.1.exe` (65 MB, lưu qua Git LFS).

Tải về máy kho:

```powershell
git lfs pull --include "warehouse-agent/releases/betacom-agent-0.12.1.exe"
```

Hoặc chép qua USB / ổ mạng từ máy lập trình.

## Các bước trên máy kho

Mở **PowerShell với quyền quản trị** (chuột phải → Run as administrator):

```powershell
# 1. Dừng dịch vụ
Stop-Service BetacomAgent

# 2. Giữ lại bản cũ để còn đường lùi
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" -Force

# 3. Chép bản mới đè lên (sửa đường dẫn nguồn cho đúng chỗ bạn để file)
Copy-Item "D:\betacom-agent-0.12.1.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force

# 4. Chạy lại
Start-Service BetacomAgent
Get-Service BetacomAgent
```

## Kiểm lại ngay sau khi chạy

Bản này **không thêm dòng log mới nào**, nên đừng soi log để biết đã lên
bản mới hay chưa — soi kích thước file:

```powershell
(Get-Item "C:\Program Files\BetacomAgent\betacom-agent.exe").Length
```

- `68261614` → đang chạy 0.12.1.
- `68260134` → vẫn là 0.12.0, chưa chép đè thành công.

Rồi thử thật: giơ một **nhãn TikTok** (loại có hai mã QR) trước camera QR.
Trang Giám sát đóng hàng phải hiện đúng mã vận đơn — không còn dòng nào
mang mã bắt đầu bằng `HTTPS://`, và cũng không còn cảnh báo "nhiều mã
trong khung" khi chỉ có một nhãn.

## Nếu phải lùi lại

```powershell
Stop-Service BetacomAgent
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force
Start-Service BetacomAgent
```

## Bản này có gì

Xem [../RELEASES.md](../RELEASES.md) mục 0.12.1. Tóm tắt: phiếu TikTok in
hai mã QR — một mã vận đơn, một link tới trang bán hàng. Agent bỏ qua cái
link và chỉ nhận mã vận đơn.

Mọi thứ của 0.12.0 giữ nguyên: đọc mã QR nhỏ, đọc cả mã vạch, tự đối chiếu
trạng thái phiên nhận hoàn. Nếu máy kho đang đặt `QR_FRAME_WIDTH=1280` /
`QR_FRAME_HEIGHT=720` trong `.env` thì cứ để nguyên, bản này không đụng tới.
