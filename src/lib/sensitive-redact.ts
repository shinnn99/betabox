/**
 * Ẩn thông tin mà người chỉ xem (Viewer) có thể lợi dụng để tác động tới
 * người dùng khác hoặc hệ thống (chủ dự án 22/09/2026).
 *
 * Quyền xem thông tin nhạy cảm: `sensitive.view` — mọi vai trò trừ Viewer.
 * Ẩn ở API (không chỉ giao diện): người thiếu quyền không nhận được dữ liệu.
 *
 *   Camera  : IP, cổng, đường dẫn RTSP, username, MAC — đủ để thử kết nối
 *             thẳng vào camera trong mạng kho. Kết quả test cũ có thể chứa
 *             URL RTSP nên chỉ giữ đúng/sai.
 *   Nhân sự : SĐT, email — thông tin cá nhân của người khác, che bớt.
 */

export const HIDDEN = "••••";

type CameraNetworkFields = {
  ip: string;
  rtsp_port: number;
  username: string;
  rtsp_path: string;
  mac_address: string | null;
  last_test_result: Record<string, unknown> | null;
};

export function redactCameraNetwork<T extends CameraNetworkFields>(c: T): T {
  return {
    ...c,
    ip: HIDDEN,
    rtsp_port: 0,
    username: HIDDEN,
    rtsp_path: HIDDEN,
    mac_address: null,
    last_test_result: c.last_test_result
      ? { success: (c.last_test_result as { success?: unknown }).success === true }
      : null,
  };
}

/** 0912345678 → 09••••678 */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return phone;
  const p = phone.trim();
  if (p.length <= 5) return HIDDEN;
  return `${p.slice(0, 2)}${HIDDEN}${p.slice(-3)}`;
}

/** nguyenvana@gmail.com → n••••@gmail.com */
export function maskEmail(email: string | null): string | null {
  if (!email) return email;
  const at = email.indexOf("@");
  if (at <= 0) return HIDDEN;
  return `${email[0]}${HIDDEN}${email.slice(at)}`;
}
