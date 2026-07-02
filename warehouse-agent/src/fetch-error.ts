/**
 * Node `fetch` (undici) throws `TypeError: fetch failed` khi tầng dưới
 * (DNS / TCP / TLS) hỏng, và giấu chi tiết vào `err.cause`. Chỉ đọc
 * `err.message` mất tất cả context để phân biệt ECONNREFUSED vs
 * CERT_HAS_EXPIRED vs EAI_AGAIN vs bị Windows firewall chặn.
 *
 * Hàm này rút gọn `err.cause` thành 1 dòng có code/errno/syscall/hostname
 * để log ra là chẩn được ngay tầng nào hỏng.
 */
export function describeFetchError(err: unknown): string {
  const top = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (!cause) return top;

  const c = cause as {
    code?: string;
    errno?: number | string;
    syscall?: string;
    hostname?: string;
    address?: string;
    port?: number;
    message?: string;
  };
  const parts: string[] = [];
  if (c.code) parts.push(`code=${c.code}`);
  if (c.errno !== undefined) parts.push(`errno=${c.errno}`);
  if (c.syscall) parts.push(`syscall=${c.syscall}`);
  if (c.hostname) parts.push(`host=${c.hostname}`);
  if (c.address) parts.push(`addr=${c.address}${c.port ? `:${c.port}` : ""}`);
  if (c.message && !parts.length) parts.push(c.message);
  return parts.length ? `${top} (${parts.join(" ")})` : top;
}
