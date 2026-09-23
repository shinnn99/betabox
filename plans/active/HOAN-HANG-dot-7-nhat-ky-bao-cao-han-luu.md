# Hàng hoàn đợt 7 — nhật ký nói cùng một thứ tiếng, báo cáo có đơn hoàn, chưa mở ca thì không quay, hạn lưu riêng

Chủ dự án chốt 23/09/2026. Năm việc, làm theo thứ tự dưới; mỗi việc xong thì
chạy `pnpm test` trước khi sang việc kế.

## 1. Cột "Loại" và "Ghi chú" của hàng hoàn ghi y như đóng hàng

**Hiện trạng.** Hai trang giám sát dùng hai bộ chữ khác nhau cho cùng một
việc:

| Tình huống | Đóng hàng | Hàng hoàn (đang có) |
|---|---|---|
| quét hợp lệ | `Hợp lệ` | `Đang mở` / `Hàng ổn` / `Có vấn đề` |
| quét trùng | `Trùng` — "Đã được quét trước đó" | `Quét lại` — "Kiện này đã ghi hoàn trước đó — không mở kiện mới" |
| lưới an toàn | `Hàng hoàn` | `Lưới an toàn` — "Mã đã gửi đi quét lại ở bàn đóng hàng — không tính đơn" |

**Chốt.** Hàng hoàn dùng ĐÚNG bộ chữ của đóng hàng, không đặt thêm loại mới,
không viết thêm câu ghi chú mới. Chi tiết riêng của kiện hoàn (loại hoàn, kết
quả kiểm) đã có cột riêng trên trang Bằng chứng hoàn hàng, không nhồi vào ghi
chú.

- `classifyReturnEvent` trả về đúng các `kind` của đóng hàng:
  `waybill_valid`, `waybill_duplicated`, `waybill_no_session`,
  `waybill_return_suspect`.
- Ghi chú dùng lại đúng câu của đóng hàng: "Đã được quét trước đó",
  "Quét khi chưa mở ca", v.v.
- Trang Giám sát hoàn hàng dùng chung bảng nhãn với trang Giám sát đóng hàng.

## 2. Quét khi chưa mở ca: không quay, không có giờ

**Hiện trạng.** Lượt quét khi không có ca vẫn tạo bản ghi, hiện giờ bắt đầu =
giờ kết thúc = giờ quét, thời gian 0s, và trang Bằng chứng còn cho bấm
"Tạo clip".

**Chốt.**
- Không cắt clip cho lượt quét không có ca: nút "Tạo clip" không hiện, API
  cắt clip từ chối.
- Hai cột thời gian để RỖNG (không lấy giờ quét làm giờ bắt đầu/kết thúc).
- Cột "Loại" ghi `Chưa mở ca` ở cả hai luồng (đóng hàng đang ghi "Chưa vào ca").

## 3. Báo cáo hiệu suất có phần đơn hoàn

Báo cáo hiện chỉ đếm `event_kind = 'outbound'`. Thêm phần hàng hoàn: số kiện
hoàn theo ngày, chia theo loại hoàn (giao thất bại / khách trả / lưới an
toàn), và số kiện có hồ sơ khiếu nại. Không trộn vào số liệu đơn đi.

## 4. Cấu hình kho: số ngày giữ video hàng hoàn

Hạn riêng cho đoạn video thuần hàng hoàn ĐÃ có ở tầng agent
(`warehouses.packing_timing_config.return_segment_retention_days`, mặc định 7)
nhưng không có chỗ nào chỉnh. Thêm ô chỉnh ngay dưới ô "Số ngày giữ video",
cùng dải 7–365 ngày, cùng cách lưu.

## 5. Cột mã vận đơn của Bằng chứng hoàn hàng (bổ sung 23/09/2026)

Bỏ hẳn nhãn lý do hoàn ("Khách trả", "Giao thất bại"...) và nhãn kết quả kiểm
("Chưa kiểm", "Hàng ổn"...) khỏi cột mã vận đơn — cùng một lẽ với mục 1: hoàn
là hoàn. Thứ duy nhất còn lại ở đó là hồ sơ khiếu nại kèm đồng hồ đếm ngược,
vì đó là cái có hạn và làm chậm là mất tiền. Chữ khắc trên video giữ nguyên.

## 6. Ghi chép

`change.md` và `changelog/2026-09-23.md`.

## Không làm trong đợt này

- Không đụng luồng đóng hàng ngoài việc đổi đúng một nhãn "Chưa vào ca" →
  "Chưa mở ca" (chủ dự án yêu cầu dùng chung một chữ).
- Không đổi cách agent ghi hình.
