import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import {
  atomicWriteFile,
  quarantineCorruptQueue,
  SerializedWriter,
} from "./atomic-file";
import type { PostClipResultParams } from "./commands";

/**
 * Outbox bền cho callback `/api/agent/clip-cut-result`.
 *
 * Sự cố 2026-08-11 (SPXVN068642901568): `postClipCutResult` được gọi
 * fire-and-forget — `await` nhưng KHÔNG đọc kết quả HTTP. Máy kho Đại
 * Kim lúc đó xen kẽ resolve domain về deployment Vercel cũ đã disable
 * (451), nên callback rơi vào hư không trong khi `command-result` lại
 * tới cloud. Row clip kẹt 'pending' → UI "Đang cắt" vĩnh viễn.
 *
 * Vì sao KHÔNG dựa vào retry của `fetchWithRetrySigned`: lớp đó cố ý
 * chỉ retry lỗi mạng (ECONNRESET, timeout…) và bỏ qua mọi response
 * HTTP — hợp lý cho nơi khác, nhưng 451 ở đây là "gõ nhầm cửa" (route
 * hoặc deployment sai), không phải "payload của agent sai". Nó tự khỏi
 * khi DNS/deployment ổn lại, nên phải retry — mà retry ở tầng dưới thì
 * chỉ sống trong một lần gọi hàm; agent restart là mất. Outbox ghi
 * xuống ổ nên sống qua cả restart lẫn mất điện.
 *
 * Định dạng: JSONL, cùng khuôn với SegmentReportQueue (atomic write +
 * quarantine dòng hỏng, không silent-drop).
 */

/**
 * Payload lưu trên ổ. Bỏ backendUrl/agentCode/agentSecret: chúng lấy từ
 * config lúc gửi. Không bao giờ ghi secret xuống ổ, và đổi BACKEND_URL
 * trong .env thì item cũ tự đi theo URL mới.
 */
export type OutboxClipResult = Omit<
  PostClipResultParams,
  "backendUrl" | "agentCode" | "agentSecret"
>;

export interface QueuedClipResult {
  enqueued_at: string;
  attempt: number;
  last_error: string | null;
  payload: OutboxClipResult;
}

/**
 * Status HTTP mà retry KHÔNG bao giờ cứu được — đó là backend đã đọc
 * hiểu request và từ chối vì chính nội dung request:
 *   400 — payload sai khuôn (thiếu field, uuid hỏng).
 *   403 — agent bị disable, hoặc clip thuộc org khác (cross-tenant).
 *   404 — clip_id không tồn tại trong DB.
 * Gửi lại y nguyên 1000 lần vẫn ra đúng chừng đó → drop + log ERROR.
 *
 * Cố ý KHÔNG xếp 401 vào đây: 401 phần lớn là lệch giờ/nonce/secret vừa
 * rotate — hết lệch là qua. Và 451/5xx thì càng phải giữ.
 */
const PERMANENT_STATUSES = new Set([400, 403, 404]);

export function isPermanentClipResultStatus(status: number): boolean {
  return PERMANENT_STATUSES.has(status);
}

/**
 * Trần tuổi của một item. Quá hạn này thì bỏ + log ERROR: giữ thêm
 * cũng vô nghĩa vì lớp 2 (cloud reconcile theo command-result) và lớp 3
 * (quét pending mồ côi) đã đóng row clip từ lâu. Giữ mãi chỉ làm file
 * phình và che mất item mới.
 */
export const OUTBOX_MAX_AGE_HOURS = 24;

export class ClipResultOutbox {
  private readonly writer: SerializedWriter<QueuedClipResult[]>;
  private readonly filePath: string;

  // Gán tường minh thay vì parameter property — Node chạy TypeScript ở
  // chế độ strip-only không hiểu cú pháp đó (cùng lý do đã ghi trong
  // fetch-error.ts LogRateLimiter).
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writer = new SerializedWriter(50, async (items) => {
      const body =
        items.length === 0
          ? ""
          : items.map((i) => JSON.stringify(i)).join("\n") + "\n";
      await atomicWriteFile(this.filePath, body);
    });
  }

  async append(payload: OutboxClipResult, lastError: string): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const line: QueuedClipResult = {
      enqueued_at: new Date().toISOString(),
      attempt: 1,
      last_error: lastError,
      payload,
    };
    await fs.appendFile(this.filePath, JSON.stringify(line) + "\n", "utf8");
  }

  async readAll(): Promise<QueuedClipResult[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const items: QueuedClipResult[] = [];
    let corrupt = 0;
    for (const line of lines) {
      try {
        items.push(JSON.parse(line) as QueuedClipResult);
      } catch {
        corrupt++;
      }
    }
    if (corrupt > 0) {
      const dest = await quarantineCorruptQueue(
        this.filePath,
        `parse_${corrupt}_lines`,
      );
      console.error(
        `[clip-outbox] ${corrupt} dòng hỏng trong ${this.filePath} — file đã quarantine sang ${dest ?? "<failed>"}`,
      );
      return items;
    }
    return items;
  }

  async rewrite(items: QueuedClipResult[]): Promise<void> {
    return this.writer.schedule(items);
  }

  async flushNow(): Promise<void> {
    return this.writer.flushNow();
  }
}

/**
 * Item quá hạn giữ? Tách hàm thuần để test không cần đụng ổ đĩa.
 */
export function isExpiredOutboxItem(
  item: QueuedClipResult,
  nowMs: number,
  maxAgeHours: number = OUTBOX_MAX_AGE_HOURS,
): boolean {
  const enqueuedMs = new Date(item.enqueued_at).getTime();
  // Timestamp rác → coi là quá hạn, không giữ item không rõ tuổi mãi mãi.
  if (!Number.isFinite(enqueuedMs)) return true;
  return nowMs - enqueuedMs >= maxAgeHours * 3600 * 1000;
}
