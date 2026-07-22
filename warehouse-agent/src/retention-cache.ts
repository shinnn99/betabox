import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Cache retention_days xuống file JSON local.
 *
 * Vì sao cần file (không chỉ giữ trong memory):
 *   1. Script PowerShell cleanup chạy độc lập với process agent (Task
 *      Scheduler). Script phải đọc được retention KHÔNG QUA agent.
 *   2. Nếu chỉ giữ memory, agent restart = mất cache = script fail-loud
 *      cho tới heartbeat đầu tiên thành công (có thể vài phút nếu mạng
 *      chập). File-cache sống qua restart.
 *
 * Chọn KHÔNG viết vào .env vì:
 *   - .env do installer sinh + Hạnh có thể sửa tay; agent ghi đè lên đó
 *     rủi ro xung đột nếu Hạnh đang sửa key khác.
 *   - File JSON riêng = ranh giới rõ (agent-managed cache), khác với
 *     env (human-managed config).
 *
 * NULL = cloud chưa cấu hình HOẶC agent chưa heartbeat lần nào thành công.
 * Script cleanup CHỈ chạy khi file tồn tại + retention_days là số hợp lệ.
 */

interface CacheContent {
  retention_days: number;
  updated_at: string;
}

const CACHE_FILENAME = "retention-cache.json";

/** Đường dẫn file cache — cùng thư mục với process agent (CWD). */
function cachePath(): string {
  return path.join(process.cwd(), CACHE_FILENAME);
}

/** Ghi cache. Chỉ gọi khi cloud trả số hợp lệ (không gọi với null). */
export async function writeRetentionCache(retentionDays: number): Promise<void> {
  const content: CacheContent = {
    retention_days: retentionDays,
    updated_at: new Date().toISOString(),
  };
  const tmpPath = `${cachePath()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(content, null, 2), "utf8");
  await fs.rename(tmpPath, cachePath());
}

/** Đọc cache. Trả null nếu file thiếu, JSON hỏng, hoặc số ngoài range. */
export async function readRetentionCache(): Promise<number | null> {
  try {
    const raw = await fs.readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as { retention_days?: unknown };
    if (
      typeof parsed.retention_days === "number" &&
      Number.isInteger(parsed.retention_days) &&
      parsed.retention_days >= 7 &&
      parsed.retention_days <= 365
    ) {
      return parsed.retention_days;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * RECOVERY_SCAN_DAYS suy từ retention: giữ retention + buffer 5 ngày (tránh
 * race giữa cleanup xóa và agent boot scan), sàn tối thiểu 30 ngày (giữ
 * behavior v0.6.3 khi retention chưa cấu hình hoặc quá nhỏ).
 *
 * Retention NULL → dùng sàn 30 (không ép agent scan cả năm khi chưa biết
 * retention). Đây là default an toàn: nếu Hạnh chưa cấu hình, agent vẫn
 * scan đủ để boot recovery hoạt động.
 */
export function computeRecoveryScanDays(retentionDays: number | null): number {
  const RECOVERY_SCAN_MIN = 30;
  const RECOVERY_BUFFER = 5;
  if (retentionDays === null) return RECOVERY_SCAN_MIN;
  return Math.max(retentionDays + RECOVERY_BUFFER, RECOVERY_SCAN_MIN);
}
