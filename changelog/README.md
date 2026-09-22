# Nhật ký dự án Betabox — từ luồng 2 camera đến nay

Mỗi file là một ngày làm việc. Nội dung tổng hợp từ lịch sử commit của nhánh `2-camera` và `change.md`. Chi tiết kỹ thuật của từng việc vẫn nằm ở `change.md` và `plans/`.

**Nhánh:** `2-camera` (tách từ `main` tại `aba1e59`) · **Số commit:** 21 · **Giai đoạn:** 14/09/2026 → 21/09/2026

---

## Dòng thời gian

| Ngày | Chủ đề chính | File |
|---|---|---|
| 14/09 | Đặt nền móng luồng 2 camera: database, kết nối camera ONVIF, relay MediaMTX, ghi hình theo ca, đọc QR từ camera, ghép PiP | [2026-09-14.md](2026-09-14.md) |
| 15/09 | Livestream hai camera trên Giám sát đóng hàng; video bằng chứng có cả hai camera; che credential trong log | [2026-09-15.md](2026-09-15.md) |
| 16/09 | Trần 3 phút mỗi đơn + đọc thành tiếng; tên file video theo mã vận đơn; nhận diện camera bằng MAC, tự dò lại IP | [2026-09-16.md](2026-09-16.md) |
| 17/09 | Gán camera theo bàn; một agent phục vụ mọi bàn; migration 2 camera lên production; kiểm thử thật; chốt phiên agent chống trùng mã | [2026-09-17.md](2026-09-17.md) |
| 18/09 | Chọn nguồn quét trên camera QR; ô Góc QR đứng dọc; agent 0.9.1 chạy dịch vụ Windows; thiết kế luồng hàng hoàn | [2026-09-18.md](2026-09-18.md) |
| 21/09 | Triển khai hàng hoàn đợt 1–6 (đợt 6: mọi bàn song song, lai với đóng hàng); hai trang Giám sát / Bằng chứng hoàn hàng; sự cố thiếu migration và xử lý | [2026-09-21.md](2026-09-21.md) |

---

## Tình trạng hiện tại (21/09/2026)

| Hạng mục | Trạng thái |
|---|---|
| Luồng 2 camera (ghi theo ca, livestream, clip PiP, đọc QR) | Chạy thật trên kho |
| Database production | Đã có đủ migration 2 camera và hàng hoàn đợt 1–5 (hậu kiểm 21/09); **chờ áp đợt 6** `20260921140000` |
| Luồng hàng hoàn (code cloud) | Xong, đã kiểm thử trên bản sao production; chưa có kiện hoàn thật nào |
| Agent trên máy kho | Bản **0.9.1** chạy dịch vụ `BetacomAgent` |
| Nhánh `2-camera` | 10 commit ở máy **chưa push** (chờ chủ dự án) |

## Việc còn tồn

1. **Áp migration đợt 6** `20260921140000_return_parallel_stations.sql` lên production (chốt chống va nhau khi bật cùng một bàn cùng lúc).
2. **Dựng và cài agent bản mới.** Bản 0.9.1 chưa biết nhận tín hiệu phiên hoàn hàng (đợt 5) và chưa có bước dọn segment hàng hoàn 7 ngày (đợt 4). Trước khi cài, bấm "Bắt đầu nhận hoàn" sẽ báo *"Máy chủ kho chưa nhận tín hiệu"*; luồng đóng hàng không bị ảnh hưởng.
3. **Chạy thật các kịch bản hàng hoàn** (kể cả lai: bàn đóng hàng + bàn nhận hoàn song song) trên kho sau khi cài agent mới.
4. **Push nhánh** khi chủ dự án cho phép.
5. **Xem camera từ xa** (kế hoạch E.1, phần B) — đang tạm hoãn theo quyết định chủ dự án.
6. Dev server đang phục vụ kho thật ở `https://localhost:3000`. Khi đưa nhánh lên production phải đổi `BACKEND_URL` trong `.env` của dịch vụ agent.

## Nguyên tắc đã chốt với chủ dự án (áp cho mọi việc sau)

- Không commit/push lên `main`; chỉ push nhánh khi chủ dự án bảo.
- Không tạo agent mới trong database; hai máy trùng mã thì tắt hoặc nâng cấp máy kia.
- Credential camera chỉ dùng trong bộ nhớ tiến trình, không ghi vào file nào.
- Migration production do chủ dự án tự dán vào SQL Editor; mỗi migration phải chạy thử trên bản sao trước.
- Hàng hoàn không xử lý tiền bạc; kiện hoàn không tính vào số đơn đóng của nhân viên.
