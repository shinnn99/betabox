import "server-only";

// Cấu hình Lark notify — đọc từ env, type-safe.
// Master toggle nằm ở env (LARK_NOTIFY_ENABLED); per-warehouse toggle nằm
// ở warehouses.notify_lark_enabled + notify_lark_webhook_url.
//
// LARK_NOTIFY_ENABLED=false → tắt toàn bộ (kill switch). Dùng khi Lark down
// hàng loạt hoặc phải dừng gấp không kịp deploy.

export const LARK_CONFIG = {
  // Kill switch. Mặc định false để dev/local không lỡ tay gọi thật.
  enabled: process.env.LARK_NOTIFY_ENABLED === "true",

  // Cửa sổ gộp — mọi lỗi trong window này chỉ gửi 1 tin, phần bị nén được
  // đưa vào tin đầu cửa sổ tiếp theo. Tăng nếu spam vẫn xảy ra; giảm nếu
  // quản lý phản hồi "biết trễ".
  windowSeconds: 300,

  // Timeout gọi Lark. Fire-and-forget nhưng vẫn cần timeout để không giữ
  // connection vô hạn khi Lark treo.
  fetchTimeoutMs: 5000,

  // Base URL cho deep-link về dashboard trong tin Lark. Ưu tiên
  // NEXT_PUBLIC_APP_URL (set explicit ở Vercel), fallback VERCEL_URL (auto),
  // cuối cùng null → không kèm link.
  dashboardBaseUrl:
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null),
} as const;

/** Làm tròn xuống mốc cửa sổ. */
export function windowStartFor(now: Date): Date {
  const ms = now.getTime();
  const winMs = LARK_CONFIG.windowSeconds * 1000;
  return new Date(Math.floor(ms / winMs) * winMs);
}
