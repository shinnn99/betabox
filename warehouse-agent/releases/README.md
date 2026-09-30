# Bộ cài Betacom Agent

File `BetacomAgentSetup-vX.Y.Z.exe` ở đây lưu qua **Git LFS** (mỗi file ~116 MB,
vượt giới hạn 100 MB của GitHub). Clone repo cần có Git LFS mới tải được file
thật; không có LFS thì chỉ nhận được file con trỏ vài trăm byte.

Bản mới nhất: **`BetacomAgentSetup-v0.13.1.exe`** — dùng cho máy kho cài mới.

- Tải: `git lfs pull --include "warehouse-agent/releases/*"`
- Cài: chuột phải file `.exe` → Run as administrator. Hướng dẫn đầy đủ:
  [../CACH-CAI-KHACH.md](../CACH-CAI-KHACH.md).
- Thay đổi từng bản: [../RELEASES.md](../RELEASES.md).

Ngoài bộ cài, thư mục này còn có **file chạy trần** `betacom-agent-X.Y.Z.exe`
(65 MB) cho những bản chỉ đổi đúng một file — thay nhanh hơn chạy lại bộ cài
và không phải nhập lại thông tin đăng ký. File chạy mới nhất:
**`betacom-agent-0.13.1.exe`** — cách thay:
[THAY-FILE-CHAY-0.13.1.md](THAY-FILE-CHAY-0.13.1.md). Máy cài mới: chạy thẳng
bộ cài 0.13.1, không cần thay file chạy nữa.

Bản 0.13.1 sửa lỗi quét mã chậm hẳn kể từ bản 0.11.0 (189ms → 12ms mỗi
khung hình). Máy kho đang chạy 0.11.0 trở lên nên thay sớm.

Mỗi bản mới chiếm thêm ~155 MB dung lượng LFS của GitHub (gói miễn phí 1 GB).
Ngày 30/09/2026 thư mục này chạm 969 MB nên đã **bỏ theo dõi Git** các bản cũ
(0.9.1, 0.11.0, 0.12.0, và các file chạy 0.12.x / 0.13.0) — file vẫn còn trên
đĩa máy lập trình, chỉ không đẩy lên GitHub nữa. Xem `.gitignore` trong thư
mục này.

**Quy ước:** Git chỉ giữ bản ĐANG DÙNG và MỘT bản lùi. Phát hành bản mới thì
thêm bản cũ vào `.gitignore` rồi `git rm --cached`.
