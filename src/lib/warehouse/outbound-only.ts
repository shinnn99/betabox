/**
 * Đếm đơn của nhân viên: CHỈ đơn đi.
 *
 * Kiện hàng hoàn nằm chung bảng `packing_events` (để dùng lại toàn bộ đường
 * ghi hình, cắt và ghép clip), phân biệt bằng cột `event_kind`. Vì vậy mọi
 * truy vấn đếm đơn phải loại kiện hoàn ra, nếu không nhân viên được tính
 * thêm đơn cho việc mở kiện hoàn — lỗi chỉ lộ ra lúc trả công.
 *
 * Có hai cách dùng, cùng một ý nghĩa:
 *   - `COUNTED_OUTBOUND_EVENTS`: view chỉ chứa đơn đi HỢP LỆ. Dùng khi truy
 *     vấn chỉ cần đơn hợp lệ (ví dụ biểu đồ sản lượng).
 *   - `OUTBOUND_ONLY`: cặp cột/giá trị để lọc khi truy vấn cần nhiều trạng
 *     thái (báo cáo, tổng quan, bảng Giám sát kho đếm cả lỗi).
 *
 * `tests/counting-excludes-returns.test.ts` canh giữ: thêm một nơi đếm đơn
 * mà quên lọc là test đỏ.
 */

/** View: `status='valid' AND event_kind='outbound'` (migration 20260921090000). */
export const COUNTED_OUTBOUND_EVENTS = "counted_outbound_events";

/** Bộ lọc loại đơn cho truy vấn thẳng vào `packing_events`. */
export const OUTBOUND_ONLY = { column: "event_kind", value: "outbound" } as const;
