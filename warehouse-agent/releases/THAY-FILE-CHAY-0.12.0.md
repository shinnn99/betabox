# Thay file chạy lên 0.12.0 (không cần bộ cài)

Bản 0.12.0 chỉ đổi **một file chạy**: không thêm file mới, không đổi cấu
hình, không đổi cách nói chuyện với hệ thống. Nên thay thẳng file là đủ,
nhanh hơn chạy lại bộ cài và không phải nhập lại thông tin đăng ký.

File: `betacom-agent-0.12.0.exe` (65 MB, lưu qua Git LFS).

Tải về máy kho:

```powershell
git lfs pull --include "warehouse-agent/releases/betacom-agent-0.12.0.exe"
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
Copy-Item "D:\betacom-agent-0.12.0.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force

# 4. Chạy lại
Start-Service BetacomAgent
Get-Service BetacomAgent
```

## Kiểm lại ngay sau khi chạy

```powershell
Get-Content "C:\Program Files\BetacomAgent\logs\agent-stdout.log" -Tail 30
```

Phải thấy:

- Dòng `Warehouse agent starting — code=...` với giờ vừa khởi động.
- Với mỗi camera QR: `[qr-frame-source] ...: camera 2560x1440 -> doc QR o
  2560x1440`. Dòng này là bằng chứng bản mới đang chạy — bản cũ không có.

Rồi giơ một nhãn TikTok trước camera QR và xem trang Giám sát đóng hàng có
hiện lượt quét không.

## Nếu phải lùi lại

```powershell
Stop-Service BetacomAgent
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force
Start-Service BetacomAgent
```

## Máy kho yếu, CPU cao sau khi lên bản mới

Bản này đọc mã ở độ phân giải gốc của camera nên tốn CPU hơn bản cũ. Nếu
máy không kham nổi, mở `C:\Program Files\BetacomAgent\.env`, thêm:

```
QR_FRAME_WIDTH=1280
QR_FRAME_HEIGHT=720
```

rồi `Restart-Service BetacomAgent`. Đổi lại là mã QR nhỏ có thể không đọc
được nữa — nên thử `1280x720` trước khi quay hẳn về `QR_STREAM=sub`.

## Bản này có gì

Xem [../RELEASES.md](../RELEASES.md) mục 0.12.0. Tóm tắt: đọc được mã QR
nhỏ (nhãn TikTok) và đọc thêm mã vạch; máy kho tự đối chiếu trạng thái
phiên nhận hoàn với hệ thống mỗi nhịp nên bàn không còn kẹt ở chế độ hoàn.
