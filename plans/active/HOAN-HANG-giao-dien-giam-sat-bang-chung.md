# Hàng hoàn — giao diện Giám sát và Bằng chứng (kế hoạch triển khai)

**Cập nhật:** 21/09/2026 · **Trạng thái:** đã xong code, chưa kiểm thật được (cần migration đợt 1–5 trên production) · **Nhánh nền:** `2-camera`
**Đọc trước:** [HOAN-HANG-phien-ghi-theo-module.md](HOAN-HANG-phien-ghi-theo-module.md) (phiên ghi hoàn theo module).

---

## 1. Yêu cầu

Nguyên văn: *làm giao diện phần giám sát hoàn hàng giống hệt phần giám sát đóng hàng, và phần bằng chứng hoàn hàng giống phần bằng chứng đóng hàng. Giống hệt, khác chức năng thôi.*

## 2. Cách làm: hai trang mới đứng riêng

Chủ dự án chốt thêm giữa chừng: **tách riêng hai phần mới, không để chung trong hai phần cũ rồi đổi chức năng bên trong.** (Bản nháp đầu định tách hai trang cũ thành một khung dùng chung có công tắc luồng — đã bỏ trước khi chạm vào trang cũ.)

| Trang | File | API |
|---|---|---|
| Giám sát đóng hàng (cũ, **không sửa**) | `app/dashboard/operations/page.tsx` | `/api/warehouse/live/*` |
| Bằng chứng giao hàng (cũ, **không sửa**) | `app/dashboard/videos/page.tsx` | `/api/order-proof/scans` |
| **Giám sát hoàn hàng** (mới) | `app/dashboard/(return-module)/returns/page.tsx` | `/api/returns/live/overview`, `/api/returns/live/proof-size-risk` |
| **Bằng chứng hoàn hàng** (mới) | `app/dashboard/(return-module)/return-videos/page.tsx` | `/api/returns/proof/scans`, `/api/returns/claims/bulk` |

Hai trang mới được **chép nguyên văn** từ trang cũ tương ứng rồi đổi phần nghiệp vụ ngay trong file mới — bố cục, màu, bảng, modal giữ y hệt. Test `tests/return-pages.test.ts` canh: trang cũ không chứa gì của hoàn hàng; trang mới không gọi API đóng hàng; các khối khung (lưới thẻ số, lưới bàn, bảng, modal…) có mặt ở cả hai bản.

Phần dùng chung chỉ nằm ở **thư viện phía server** (`lib/warehouse/live/summary.ts`, `stations.ts`, `lib/order-proof/service.ts`, `lib/order-proof/proof-size-risk.ts`) — mặc định luôn là đơn đi, route đóng hàng không truyền luồng nào khác (có test canh).

Hệ quả phải nhớ: sửa giao diện trang đóng hàng thì soi lại trang hoàn hàng tương ứng — hai file không tự đồng bộ.

## 3. Khác chức năng ở đâu

### Giám sát

| Khối | Đóng hàng | Hoàn hàng |
|---|---|---|
| 4 thẻ số | Đã quét · Đơn trùng · Cần xử lý · Nhân sự | Đã nhận · Quét lại · Cần xử lý (hồ sơ mở) · Nhân sự |
| Thẻ bàn | số đơn hôm nay | số kiện hoàn hôm nay + nhãn chế độ bàn |
| Cần xử lý | lỗi quét | hồ sơ kiện có vấn đề chưa khiếu nại, kiện bị lưới an toàn bắt |
| Nhật ký | mọi lượt quét + vào/ra ca | kiện hoàn (mở, kết quả kiểm) + thẻ điều khiển |
| Tab | Tất cả · Hợp lệ · Trùng · Cần xử lý · QR nhân sự | Tất cả · Hàng ổn · Quét lại · Cần xử lý · Thẻ điều khiển |
| Riêng | — | Ô **Bắt đầu / Kết thúc nhận hoàn** (tín hiệu module, đợt 5) |

### Bằng chứng

| Khối | Đóng hàng | Hoàn hàng |
|---|---|---|
| Danh sách | đơn đi | kiện hoàn |
| Cột thời gian | T/g đóng đơn | T/g kiểm hàng |
| Nhãn dòng | Đơn lỗi (đánh dấu tay) | Kết quả kiểm + trạng thái hồ sơ |
| Hành động hàng loạt | Đánh dấu lỗi / Bỏ đánh dấu | Đã khiếu nại / Không cần |
| Modal | video + thông tin | video + thông tin + nút **Xem video lúc gửi đi** |

## 4. Tín hiệu module khi có hai trang

Hai trang hoàn hàng nằm chung route group `app/dashboard/(return-module)/` với một `layout.tsx` giữ phiên nhận hoàn. Layout của Next.js **không bị dựng lại** khi chuyển giữa các trang con, nên:

- Giám sát hoàn hàng ⇄ Bằng chứng hoàn hàng: phiên vẫn giữ, nhịp 30 giây vẫn chạy.
- Rời sang bất kỳ trang nào khác (hoặc đóng tab): gửi tín hiệu đóng — đúng nghĩa "thoát khỏi giao diện hoàn hàng".

URL cố ý không lồng nhau (`/dashboard/returns` và `/dashboard/return-videos`) vì sidebar đánh dấu mục đang mở theo tiền tố đường dẫn — lồng nhau thì mục Giám sát sáng cả khi đang ở trang Bằng chứng.

## 5. Sửa kèm (lỗi đã có từ trước, phát hiện khi làm)

- Trang **Bằng chứng giao hàng** đang liệt kê cả kiện hoàn (lọc theo `status='valid'` mà không lọc loại).
- Thẻ bàn trên **Giám sát đóng hàng** đếm cả kiện hoàn vào "Hôm nay N đơn".
- Trang Hàng hoàn cũ không có khung dashboard (thiếu sidebar).
- Nhật ký Giám sát đóng hàng gọi lượt quét ở bàn đang nhận hoàn là **"Hợp lệ"** như một đơn đi (lọt cả vào tab Hợp lệ), và gọi thẻ điều khiển là **"Đang chờ xử lý"** như mã bị kẹt. Giờ gắn đúng nhãn kiện hoàn / thẻ.
- Ước lượng dung lượng clip của trang đóng hàng tính lẫn kiện hoàn.
- "Đánh dấu lỗi" chặn ở server: chỉ chạm đơn đi — dấu đó tính vào hiệu suất đóng gói của nhân viên.

## 6. Dọn

Trang Hàng hoàn cũ (danh sách + phát hai video cạnh nhau), `ReturnClipPlayer`, `GET /api/returns` được thay bằng hai trang mới → xoá.
