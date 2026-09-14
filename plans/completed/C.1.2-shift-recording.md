# C.1.2 — Ghi hình theo ca

Nối sự kiện staff QR local vào recording tức thời, delayed stop 60 giây/cancel stop, và boot reconcile theo trạng thái ca từ cloud.

**Trạng thái:** Đã hoàn thành

## Kết quả

- Đồng bộ cấu hình camera của đúng agent: vai trò, nguồn quét, mã scanner ảo và trạng thái ca.
- Staff QR tại máy bàn bật ghi ngay từ cache RAM, không chờ WAN; session local được adopt khi cloud gửi lệnh chính thức.
- Boot chỉ phục hồi camera khi cloud xác nhận bàn có ca `active`.
- Stop nhận mốc `stop_at`, dừng trễ và được huỷ khi ca mới mở.
- Trigger M10 điều phối camera theo assignment/vai trò: ca đầu start, ca cuối stop +60 giây.

## Kiểm tra

- `warehouse-agent`: typecheck và 78/78 test đạt.
- Root: typecheck và ESLint file liên quan đạt.
- Migration version: 79 version, không trùng.
- PostgreSQL 17 cô lập: migration và các ca trigger mở/đóng/mở lại, hai nhân viên, camera/scanner đều đạt.
