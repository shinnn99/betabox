# Thay file chạy lên 0.13.1 (không cần bộ cài)

Bản 0.13.1 chỉ đổi **một file chạy**: không thêm file mới, không đổi `.env`.
Thay thẳng file là đủ.

File: `betacom-agent-0.13.1.exe` (65 MB, lưu qua Git LFS).

```powershell
git lfs pull --include "warehouse-agent/releases/betacom-agent-0.13.1.exe"
```

Hoặc chép qua USB / ổ mạng từ máy lập trình.

## Bản này sửa gì

**Quét mã nhanh trở lại: 189ms → 12ms mỗi khung.**

Từ bản 0.11.0 (24/09) nhân viên phải giơ nhãn rất lâu mới quét ăn. Nguyên
nhân không phải việc thêm mã vạch, mà là bản đó cùng lúc nâng độ nét ảnh
đưa vào máy đọc lên quá cao (2560x1440). Mỗi giây camera gửi 10 ảnh nhưng
máy xử lý một ảnh còn không kịp, nên phần lớn ảnh bị bỏ — mà luật xác nhận
đòi hai ảnh liên tiếp cùng đọc ra một mã.

Nay đọc hai pha (pha nhanh trước, chỉ soi kỹ khi pha nhanh không thấy gì)
và hạ trần ảnh về 1920x1080. **Vẫn đọc được đúng như trước**: mã QR nhỏ
nhãn TikTok, mã vạch Code128, và các loại mã ít gặp.

## KHÔNG cần chạy migration

Khác bản 0.13.0. Các migration cần thiết đã chạy xong trên hệ thống ngày
30/09/2026 — máy kho chỉ cần thay file chạy.

## Các bước trên máy kho

Mở **PowerShell với quyền quản trị** (chuột phải → Run as administrator):

```powershell
# 1. Dừng dịch vụ
Stop-Service BetacomAgent

# 2. Giữ lại bản cũ để còn đường lùi
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" -Force

# 3. Chép bản mới đè lên (sửa đường dẫn nguồn cho đúng chỗ bạn để file)
Copy-Item "D:\betacom-agent-0.13.1.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force

# 4. Chạy lại
Start-Service BetacomAgent
Get-Service BetacomAgent
```

## Kiểm lại ngay sau khi chạy

Mở trang **Platform → Đội agent**, trong vòng 1 phút máy kho phải hiện
phiên bản **0.13.1**.

Nếu trang vẫn hiện bản cũ, soi kích thước file cho chắc đã chép đè —

```powershell
(Get-Item "C:\Program Files\BetacomAgent\betacom-agent.exe").Length
```

- `68339989` → đang chạy 0.13.1.
- `68310917` → vẫn là 0.13.0, chưa chép đè thành công.

Rồi thử thật — đây là phần quan trọng nhất của bản này:

1. **Giơ nhãn lên camera QR ở bàn đóng hàng.** Mã phải được nhận gần như
   ngay khi nhãn vào khung hình, không còn phải giữ yên chờ vài giây.
2. **Thử nhãn có mã QR nhỏ** (nhãn TikTok) và **nhãn chỉ có mã vạch**
   (J&T) — cả hai vẫn phải đọc được.

## Nếu phải lùi lại

```powershell
Stop-Service BetacomAgent
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force
Start-Service BetacomAgent
```

Lùi về 0.13.0 an toàn: không có thay đổi nào ở database hay giao thức, chỉ
là quay lại cách đọc mã cũ (chậm).

## Nếu máy kho yếu, muốn nhẹ thêm

Hạ trần ảnh trong `.env` rồi khởi động lại dịch vụ:

```
QR_FRAME_WIDTH=1600
QR_FRAME_HEIGHT=900
```

**Cân nhắc:** dưới 1920x1080 thì mã QR nhỏ (nhãn TikTok 12mm) có thể không
đọc được nữa. Chỉ hạ khi bàn đó không dùng nhãn TikTok.

## Bản này có gì

Xem [../RELEASES.md](../RELEASES.md) mục 0.13.1.
