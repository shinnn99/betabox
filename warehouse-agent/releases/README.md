# Bộ cài Betacom Agent

File `BetacomAgentSetup-vX.Y.Z.exe` ở đây lưu qua **Git LFS** (mỗi file ~116 MB,
vượt giới hạn 100 MB của GitHub). Clone repo cần có Git LFS mới tải được file
thật; không có LFS thì chỉ nhận được file con trỏ vài trăm byte.

Bản mới nhất: **`BetacomAgentSetup-v0.14.0.exe`** — dùng cho máy kho cài mới.

> **Đừng dùng 0.13.1.** Bản đó dựng trước khi gộp nhánh nên thiếu bản sửa kẹt
> đổi tên file hàng đợi trên Windows. Phần quét mã hai bản y hệt nhau.

- Tải: `git lfs pull --include "warehouse-agent/releases/*"`
- Cài: chuột phải file `.exe` → Run as administrator. Hướng dẫn đầy đủ:
  [../CACH-CAI-KHACH.md](../CACH-CAI-KHACH.md).
- Thay đổi từng bản: [../RELEASES.md](../RELEASES.md).

Ngoài bộ cài, thư mục này còn có **file chạy trần** `betacom-agent-X.Y.Z.exe`
(65 MB) cho những bản chỉ đổi đúng một file — thay nhanh hơn chạy lại bộ cài
và không phải nhập lại thông tin đăng ký. File chạy mới nhất:
**`betacom-agent-0.14.0.exe`** — cách thay:
[THAY-FILE-CHAY-0.14.0.md](THAY-FILE-CHAY-0.14.0.md). Máy cài mới: chạy thẳng
bộ cài 0.14.0, không cần thay file chạy nữa.

Bản 0.14.0 thêm phép đo riêng dung lượng thư mục video, để trang *Dung lượng
lưu trữ* nói được "video chiếm bao nhiêu" chứ không chỉ "ổ còn trống bao
nhiêu". Không đổi gì ở phần ghi hình. Máy chưa cập nhật vẫn chạy bình thường,
chỉ riêng ô "Thư mục lưu video" hiện gạch ngang.

Bản lùi là **0.13.2** (sửa quét mã chậm 189ms → 12ms kể từ 0.11.0, kèm bản sửa
kẹt đổi tên file hàng đợi trên Windows). Máy nào còn dưới 0.13.2 thì nên lên
thẳng 0.14.0.

Mỗi bản mới chiếm thêm ~155 MB dung lượng LFS của GitHub (gói miễn phí 1 GB).
Ngày 30/09/2026 thư mục này chạm 969 MB nên đã **bỏ theo dõi Git** các bản cũ
(0.9.1, 0.11.0, 0.12.0, và các file chạy 0.12.x / 0.13.0) — file vẫn còn trên
đĩa máy lập trình, chỉ không đẩy lên GitHub nữa. Đợt 0.14.0 (05/10/2026) bỏ
theo dõi thêm bộ cài **0.12.1**, vì 0.13.2 đã tụt xuống làm đường lùi. Xem
`.gitignore` trong thư mục này.

**Quy ước:** Git chỉ giữ bản ĐANG DÙNG và MỘT bản lùi. Phát hành bản mới thì
thêm bản cũ vào `.gitignore` rồi `git rm --cached`.
