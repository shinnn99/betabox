/**
 * Nhịp poll chỉ chạy khi tab đang được nhìn.
 *
 * Vì sao có file này: tháng 8/2026 tài khoản Vercel bị khoá vì vượt cả bốn
 * hạn mức, và phần lớn lưu lượng là các trang dashboard poll đều đặn suốt
 * ngày — kể cả khi tab bị ẩn, cửa sổ thu nhỏ hay máy khoá màn hình. Không
 * ai đọc con số trong lúc đó, nhưng request thì vẫn tính tiền.
 *
 * Hai hành vi, đi liền nhau — thiếu vế thứ hai là đổi tiết kiệm lấy dữ liệu
 * cũ trước mắt người dùng:
 *   1. Tab ẩn  → bỏ nhịp, không gọi gì.
 *   2. Tab hiện trở lại → gọi NGAY, không bắt chờ hết chu kỳ.
 *
 * KHÔNG tự gọi lúc khởi tạo: nhiều trang cần lượt tải đầu tiên mang tham số
 * riêng (ví dụ trang giám sát phải kèm nhật ký). Caller tự gọi lượt đầu rồi
 * giao nhịp lặp cho hàm này.
 */

export interface VisibilityDoc {
  visibilityState: string;
  addEventListener(type: "visibilitychange", handler: () => void): void;
  removeEventListener(type: "visibilitychange", handler: () => void): void;
}

export interface VisibilityPollingOptions {
  /**
   * Nhịp cố định, HOẶC một hàm được hỏi lại trước mỗi lần hẹn giờ để lấy
   * nhịp hiện hành (nhịp co giãn — xem `adaptive-interval.ts`).
   *
   * Dạng hàm dùng `setTimeout` lặp thay vì `setInterval`: nhịp đổi giữa
   * chừng phải có hiệu lực ngay ở lần hẹn kế tiếp, mà `setInterval` thì
   * không đổi chu kỳ được sau khi đã đặt.
   */
  intervalMs: number | (() => number);
  onTick: () => void;
  /** Tiêm được để test không cần DOM thật. */
  doc?: VisibilityDoc;
  schedule?: (handler: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** Trả hàm dọn dẹp — gọi trong cleanup của useEffect. */
export function startVisibilityPolling(
  opts: VisibilityPollingOptions,
): () => void {
  const doc = opts.doc ?? (document as unknown as VisibilityDoc);
  // Chốt loại timer TRƯỚC khi chọn scheduler mặc định. Nhịp cố định dùng
  // setInterval; nhịp co giãn PHẢI dùng setTimeout one-shot rồi tự hẹn lại.
  // Dùng setInterval ở nhánh co giãn sẽ khiến mỗi callback tạo thêm một
  // interval mới, số timer tăng dần và cleanup chỉ huỷ được handle cuối.
  const dynamic = typeof opts.intervalMs === "function";
  const schedule =
    opts.schedule ??
    (dynamic
      ? ((handler: () => void, ms: number) => setTimeout(handler, ms))
      : ((handler: () => void, ms: number) => setInterval(handler, ms)));
  const cancel =
    opts.cancel ??
    (dynamic
      ? ((handle: unknown) => clearTimeout(handle as never))
      : ((handle: unknown) => clearInterval(handle as never)));

  const isVisible = () => doc.visibilityState === "visible";

  // Nhịp cố định: giữ nguyên đường cũ (một `setInterval`, không đụng gì).
  // Nhịp co giãn: tự hẹn lại sau mỗi lượt để nhịp mới có hiệu lực ngay.
  const readInterval = (): number =>
    typeof opts.intervalMs === "function" ? opts.intervalMs() : opts.intervalMs;

  let handle: unknown;
  let stopped = false;

  if (dynamic) {
    const armNext = () => {
      if (stopped) return;
      handle = schedule(() => {
        if (stopped) return;
        if (isVisible()) opts.onTick();
        // Hẹn lại BẤT KỂ tab ẩn hay hiện: vòng hẹn giờ phải sống tiếp, nếu
        // không thì tab ẩn một lần là nhịp chết hẳn và người dùng quay lại
        // sẽ thấy màn hình đứng im vĩnh viễn. Tab ẩn chỉ bỏ lượt GỌI.
        armNext();
      }, readInterval());
    };
    armNext();
  } else {
    handle = schedule(() => {
      if (isVisible()) opts.onTick();
    }, readInterval());
  }

  const onVisibilityChange = () => {
    if (isVisible()) opts.onTick();
  };
  doc.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    stopped = true;
    cancel(handle);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
