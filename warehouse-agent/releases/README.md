# Bộ cài Betacom Agent

File `BetacomAgentSetup-vX.Y.Z.exe` ở đây lưu qua **Git LFS** (mỗi file ~116 MB,
vượt giới hạn 100 MB của GitHub). Clone repo cần có Git LFS mới tải được file
thật; không có LFS thì chỉ nhận được file con trỏ vài trăm byte.

Bản mới nhất: **`BetacomAgentSetup-v0.12.1.exe`** — dùng cho máy kho cài mới.

- Tải: `git lfs pull --include "warehouse-agent/releases/*"`
- Cài: chuột phải file `.exe` → Run as administrator. Hướng dẫn đầy đủ:
  [../CACH-CAI-KHACH.md](../CACH-CAI-KHACH.md).
- Thay đổi từng bản: [../RELEASES.md](../RELEASES.md).

Ngoài bộ cài, thư mục này còn có **file chạy trần** `betacom-agent-X.Y.Z.exe`
(65 MB) cho những bản chỉ đổi đúng một file — thay nhanh hơn chạy lại bộ cài
và không phải nhập lại thông tin đăng ký. File chạy mới nhất:
**`betacom-agent-0.13.1.exe`** — cách thay:
[THAY-FILE-CHAY-0.13.1.md](THAY-FILE-CHAY-0.13.1.md). Máy cài mới: chạy bộ cài
0.12.1 rồi thay file chạy lên 0.13.1 (các bản 0.13.x không đổi file nào khác).

Bản 0.13.1 sửa lỗi quét mã chậm hẳn kể từ bản 0.11.0 (189ms → 12ms mỗi
khung hình). Máy kho đang chạy 0.11.0 trở lên nên thay sớm.

Mỗi bản mới chiếm thêm ~116 MB dung lượng LFS của GitHub (gói miễn phí 1 GB);
chỉ giữ bản đang dùng, xoá bản cũ khi không cần.
