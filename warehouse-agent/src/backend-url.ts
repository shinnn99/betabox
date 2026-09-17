import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Tìm đúng cổng của cloud khi chạy dev trên cùng máy.
 *
 * Vì sao cần: `BACKEND_URL` trong `.env` ghi cứng `https://localhost:3000`.
 * Next chỉ ưu tiên 3000 chứ không giữ chỗ — cổng bận thì nó nhảy sang 3001,
 * 3002... Lúc đó agent vẫn gõ cửa 3000, không ai trả lời, và toàn bộ việc
 * báo cáo dừng trong khi ghi hình vẫn chạy: nhìn bên ngoài như hệ thống
 * sống, thực ra không có gì lên cloud.
 *
 * Nguồn tin cậy nhất là `.next/dev/lock` — Next tự ghi cổng thật vào đó:
 *   {"pid":20584,"port":3000,"hostname":"localhost","appUrl":"http://localhost:3000"}
 *
 * Production KHÔNG bị đụng tới: URL không phải localhost thì trả về nguyên
 * xi, không dò gì cả. Dò cổng ở production là mở đường cho agent tự nối vào
 * một máy chủ lạ.
 */

export const DEV_PORT_CANDIDATES = [3000, 3001, 3002, 3003, 3004, 3005];

/** Đường thăm dò nhẹ nhất: không cần xác thực, không ghi gì. */
export const PROBE_PATH = "/api/warehouse/time-check";

export function isLocalBackend(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Đổi cổng của một URL, giữ nguyên scheme và host. */
export function withPort(url: string, port: number): string {
  const u = new URL(url);
  u.port = String(port);
  return u.toString().replace(/\/+$/, "");
}

/** Đọc cổng từ nội dung file lock của Next. Trả null nếu không đọc được. */
export function parseDevLockPort(raw: string): number | null {
  try {
    const data = JSON.parse(raw) as { port?: unknown };
    const port = typeof data.port === "number" ? data.port : Number(data.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

export interface ResolveBackendUrlResult {
  url: string;
  source: "configured" | "remote" | "dev-lock" | "probe" | "unreachable";
}

/**
 * Trả về URL cloud dùng được. Thứ tự ưu tiên có chủ đích:
 *   1. URL đang cấu hình, nếu nó trả lời — không gây bất ngờ cho ai.
 *   2. Cổng ghi trong `.next/dev/lock` — chính xác, không phải đoán.
 *   3. Dò lần lượt vài cổng quen thuộc — lưới cuối khi lock cũ/mất.
 */
export async function resolveBackendUrl(input: {
  configured: string;
  /** Thư mục gốc của repo, để tìm `.next/dev/lock`. */
  projectRoot?: string;
  readLock?: (path: string) => Promise<string>;
  probe?: (url: string) => Promise<boolean>;
  candidatePorts?: number[];
}): Promise<ResolveBackendUrlResult> {
  const configured = input.configured.replace(/\/+$/, "");
  if (!isLocalBackend(configured)) {
    return { url: configured, source: "remote" };
  }

  const probe = input.probe ?? defaultProbe;
  if (await probe(configured)) return { url: configured, source: "configured" };

  const tried = new Set<string>([configured]);

  const lockPath = resolve(input.projectRoot ?? "..", ".next", "dev", "lock");
  try {
    const raw = await (input.readLock ?? defaultReadLock)(lockPath);
    const port = parseDevLockPort(raw);
    if (port !== null) {
      const candidate = withPort(configured, port);
      if (!tried.has(candidate)) {
        tried.add(candidate);
        if (await probe(candidate)) return { url: candidate, source: "dev-lock" };
      }
    }
  } catch {
    // Không có file lock (chạy production build, hoặc dev chưa bật) — bỏ qua.
  }

  for (const port of input.candidatePorts ?? DEV_PORT_CANDIDATES) {
    const candidate = withPort(configured, port);
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    if (await probe(candidate)) return { url: candidate, source: "probe" };
  }

  // Không tìm thấy: trả lại URL cấu hình để agent vẫn retry như cũ thay vì
  // chết hẳn. Cloud bật lên sau sẽ được nhặt ở lần dò định kỳ.
  return { url: configured, source: "unreachable" };
}

async function defaultReadLock(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function defaultProbe(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`${baseUrl}${PROBE_PATH}`, {
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
