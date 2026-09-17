import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mã phiên của tiến trình agent trên MÁY NÀY, gửi kèm mỗi lượt hỏi lệnh.
 *
 * Cloud chỉ cấp lệnh cho một phiên mỗi mã agent (xem
 * src/lib/warehouse/agent-instance-lease.ts phía web). Lưu ra file trong
 * thư mục dữ liệu để khởi động lại agent trên cùng máy vẫn là phiên cũ —
 * nhận lệnh lại ngay, không phải chờ hết hạn thuê 30 giây như một máy lạ.
 *
 * Đọc/ghi hỏng (ổ chỉ đọc, file rác) thì dùng mã tạm trong RAM: agent vẫn
 * chạy, chỉ mất lợi thế giữ quyền qua lần khởi động lại.
 */
export function loadAgentInstanceId(filePath: string): string {
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (UUID_RE.test(existing)) return existing.toLowerCase();
  } catch {
    // chưa có file — tạo mới bên dưới
  }
  const fresh = randomUUID();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${fresh}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[agent-instance] không lưu được mã phiên (${(err as Error).message}) — dùng mã tạm, khởi động lại sẽ phải chờ hết hạn thuê`,
    );
  }
  return fresh;
}

/** Cloud từ chối vì mã agent đang chạy ở máy khác. */
export class AgentInstanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInstanceConflictError";
  }
}
