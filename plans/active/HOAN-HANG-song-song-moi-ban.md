# Hàng hoàn — mọi bàn song song, lai với đóng hàng (đợt 6)

**Cập nhật:** 21/09/2026 · **Trạng thái:** xong code, đã kiểm thử trên bản sao production; chờ áp migration `20260921140000` lên production · **Nhánh:** `2-camera`
**Đọc trước:** [HOAN-HANG-phien-ghi-theo-module.md](HOAN-HANG-phien-ghi-theo-module.md) (đợt 5)

## 1. Yêu cầu

- *Tất cả các bàn đều xử lý hoàn hàng cùng một lúc được, hoạt động song song như luồng đóng hàng.*
- *Vẫn phải lai được: ví dụ bàn 1, 2 đóng hàng còn bàn 3, 4 hoàn hàng song song cùng lúc; một máy kho điều khiển tất cả các bàn và các camera.*

## 2. Cái gì đã song song sẵn

Mọi thứ khoá theo **từng bàn**: mỗi bàn một kỳ chế độ mở, mỗi bàn tối đa một lượt đang mở, agent giữ nhiều phiên (mỗi bàn một phiên, gán nhãn theo camera). Hai bàn khác nhau không bao giờ tranh nhau — kể cả khi chung một agent.

## 3. Ba chỗ chặn đã sửa

| # | Chặn | Sửa |
|---|---|---|
| 1 | Giao diện chỉ giữ được **một bàn** mỗi trình duyệt | Bảng "Phiên nhận hoàn" hiện mọi bàn, bật/tắt từng bàn hoặc **Bắt đầu tất cả / Kết thúc tất cả**. Nhịp 30 giây gửi **một** request cho mọi bàn đang giữ; rời phân hệ nhả mọi bàn bằng **một** tín hiệu. |
| 2 | Người giữ phiên tính theo **tài khoản** → nhiều máy dùng chung tài khoản sẽ tắt phiên của nhau | Tính theo **tab**: `module:<user_id>:<tab_id>`. Phần tài khoản luôn lấy từ phiên đăng nhập ở server. `tab_id` sinh mới mỗi lần tải trang, không lưu `sessionStorage` (nhân bản tab sẽ chép nó). |
| 3 | Thẻ QR và nút giao diện bật **cùng một bàn đúng cùng lúc** → lỗi `duplicate key … station_mode_periods_one_open_idx` | Khoá tư vấn **theo bàn** ở đầu `open_return_capture` / `release_return_capture`. Không khoá theo tổ chức — đó là biến các bàn thành xếp hàng. |

## 4. Bằng chứng

- **Va nhau là có thật:** hai tiến trình mở phiên cùng một bàn cùng lúc, 20 lượt — bản đợt 5 (đang chạy trên production): **20/20 lỗi**; bản đợt 6: **0/20**, cả hai tab được ghi nhận.
- **Khoá không làm bàn khác chờ:** bàn A giữ khoá 3 giây, bàn B mở phiên xong trong ~0,5 giây (gần như toàn bộ là thời gian khởi động lệnh); lượt thứ hai ở cùng bàn A thì chờ đúng lượt đầu.
- **4 bàn nhận hoàn cùng lúc** (8 kịch bản): mỗi bàn giữ đúng kiện của mình; thẻ kết quả, quét kiện kế tiếp, mất nhịp, đóng ca ở bàn này không đụng bàn khác; hai tab cùng tài khoản ở một bàn, một tab thoát thì bàn vẫn nhận hoàn.
- **Lai đúng ví dụ của chủ dự án:** bàn 1, 2 đóng hàng + bàn 3, 4 nhận hoàn, quét xen kẽ; view đếm đơn chỉ có đơn của bàn 1, 2; thẻ kết quả quét nhầm ở bàn đóng hàng không làm gì; **đổi vai giữa chừng** (bàn 4 về đóng hàng, bàn 1 sang nhận hoàn) — đơn đang mở ở bàn 1 được chốt đúng lúc đổi chế độ.
- **Một agent, 8 camera của 4 bàn**, các đoạn cuộn lệch nhịp: camera bàn đóng hàng không mang nhãn; camera bàn 3 và bàn 4 không lẫn nhãn nhau; đổi vai giữa chừng vẫn đúng luật đoạn dở; phiên bàn 4 kết thúc đúng một lần sau khi cả hai camera của nó lưu xong.

## 5. Triển khai

1. Chủ dự án áp `supabase/migrations/20260921140000_return_parallel_stations.sql` lên production. Code mới **chạy được cả khi chưa áp** — chỉ còn thiếu chốt chống va nhau trong cùng một bàn.
2. Agent trên máy kho cần bản mới (đợt 5 trở đi) để nhận tín hiệu phiên hoàn — xem `log/README.md`, việc còn tồn.
