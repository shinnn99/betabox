import type { ReactNode } from "react";
import ReturnCaptureProvider from "@/components/returns/ReturnCaptureProvider";

/**
 * Layout chung của phân hệ hoàn hàng: Giám sát hoàn hàng và Bằng chứng hoàn
 * hàng.
 *
 * Tồn tại để giữ phiên nhận hoàn: layout không bị dựng lại khi chuyển giữa
 * hai trang con, nên nhịp 30 giây chạy liên tục; rời hẳn phân hệ thì
 * provider gỡ ra và gửi tín hiệu đóng. Route group `(return-module)` không
 * xuất hiện trong URL — hai trang vẫn là /dashboard/returns và
 * /dashboard/return-videos (cố ý không lồng nhau, vì sidebar đánh dấu mục
 * đang mở theo tiền tố đường dẫn).
 */
export default function ReturnModuleLayout({ children }: { children: ReactNode }) {
  return <ReturnCaptureProvider>{children}</ReturnCaptureProvider>;
}
