/**
 * Lõi thuần của `guard` (tách ra để test được): quyền chưa tải → bỏ qua;
 * không có quyền → báo, KHÔNG chạy `fn`; có quyền → chạy `fn`.
 */
export function runGuarded(
  ready: boolean,
  allowed: boolean,
  action: string,
  fn: () => void,
  notify: (message: string) => void,
): "skipped" | "denied" | "ran" {
  if (!ready) return "skipped";
  if (!allowed) {
    notify(`Bạn không có quyền ${action}.`);
    return "denied";
  }
  fn();
  return "ran";
}
