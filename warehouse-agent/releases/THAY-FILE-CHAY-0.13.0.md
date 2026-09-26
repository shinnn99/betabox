# Thay file chạy lên 0.13.0 (không cần bộ cài)

Bản 0.13.0 chỉ đổi **một file chạy**: không thêm file mới, không đổi `.env`.
Thay thẳng file là đủ.

File: `betacom-agent-0.13.0.exe` (65 MB, lưu qua Git LFS).

```powershell
git lfs pull --include "warehouse-agent/releases/betacom-agent-0.13.0.exe"
```

Hoặc chép qua USB / ổ mạng từ máy lập trình.

## TRƯỚC khi thay: chạy migration trên hệ thống

Chạy **`supabase/migrations/20260926130000_agent_self_report.sql`** trong SQL
Editor trước. Chưa chạy thì máy kho vẫn chạy bình thường, nhưng hệ thống bỏ
qua bản tự khai và lệnh Thu chẩn đoán chưa gửi được.

## Các bước trên máy kho

Mở **PowerShell với quyền quản trị** (chuột phải → Run as administrator):

```powershell
# 1. Dừng dịch vụ
Stop-Service BetacomAgent

# 2. Giữ lại bản cũ để còn đường lùi
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" -Force

# 3. Chép bản mới đè lên (sửa đường dẫn nguồn cho đúng chỗ bạn để file)
Copy-Item "D:\betacom-agent-0.13.0.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force

# 4. Chạy lại
Start-Service BetacomAgent
Get-Service BetacomAgent
```

## Kiểm lại ngay sau khi chạy

Từ bản này **không cần soi kích thước file nữa**: mở trang **Platform → Đội
agent**, trong vòng 1 phút máy kho phải hiện phiên bản **0.13.0**, số camera
đang ghi, và ổ đĩa còn bao nhiêu.

Nếu trang vẫn hiện "chưa tự khai": soi kích thước file cho chắc đã chép đè —

```powershell
(Get-Item "C:\Program Files\BetacomAgent\betacom-agent.exe").Length
```

- `68310917` → đang chạy 0.13.0 (khi đó kiểm lại migration ở trên).
- `68261614` → vẫn là 0.12.1, chưa chép đè thành công.

Rồi thử thật:

1. Đóng vài đơn liên tiếp bằng camera QR — trang Giám sát đóng hàng không còn
   thời lượng âm, và lượt quét lên ngay (không còn trễ 1–3 phút khi có người
   đang xem video).
2. Mở video một đơn vừa đóng xong — nếu đoạn video cuối còn đang ghi, trang
   hiện "đang chuẩn bị" rồi tự cắt khi đoạn đóng, không còn "Lỗi: Segment cuối
   chưa đóng".

## Nếu phải lùi lại

```powershell
Stop-Service BetacomAgent
Copy-Item "C:\Program Files\BetacomAgent\betacom-agent-cu.exe" `
          "C:\Program Files\BetacomAgent\betacom-agent.exe" -Force
Start-Service BetacomAgent
```

Lùi về 0.12.1 an toàn: hệ thống chỉ mở cửa sổ clip kiện hoàn 310 giây cho máy
nào tự khai được hạ bitrate, nên máy chạy bản cũ tự quay về trần cũ.

## Bản này có gì

Xem [../RELEASES.md](../RELEASES.md) mục 0.13.0.
