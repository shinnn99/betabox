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
  intervalMs: number;
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
  const schedule =
    opts.schedule ??
    ((handler: () => void, ms: number) => setInterval(handler, ms));
  const cancel =
    opts.cancel ?? ((handle: unknown) => clearInterval(handle as never));

  const isVisible = () => doc.visibilityState === "visible";

  const handle = schedule(() => {
    if (isVisible()) opts.onTick();
  }, opts.intervalMs);

  const onVisibilityChange = () => {
    if (isVisible()) opts.onTick();
  };
  doc.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    cancel(handle);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
