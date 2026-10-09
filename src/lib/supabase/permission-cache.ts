/**
 * Phần QUYẾT ĐỊNH của đệm ma trận quyền — thuần, không đụng DB, test được
 * không cần server. Phần I/O nằm ở `guard.ts`.
 *
 * Vì sao tách (đo 06/10/2026): `checkPermission` chạy MỘT truy vấn
 * `role_permission_matrix` cho mỗi lượt gọi API — 42.402 lượt/24h. Bảng này
 * gần như bất động (chỉ đổi khi admin nền tảng bấm lưu), nên đệm được.
 *
 * Luật sống còn ở đây là FAIL-CLOSED: đây là cửa bảo vệ, không phải bộ nhớ
 * tăng tốc thường. Đọc hỏng thì KHÔNG được đệm và KHÔNG được coi là có
 * quyền — thà chặn nhầm còn hơn mở nhầm.
 */

export const PERMISSION_TTL_MS = 60_000;

export interface PermissionCacheEntry {
  grants: Set<string>;
  at: number;
}

export type PermissionGrantLoader = () => Promise<Set<string> | null>;

/**
 * Đệm I/O dùng chung cho guard. Ngoài TTL, lớp này giữ hai bất biến mà một
 * biến module đơn giản không giữ được khi request chạy đồng thời:
 *
 * 1. Nhiều request cùng gặp cache lạnh chỉ tạo MỘT lượt đọc DB.
 * 2. Nếu admin invalidate trong lúc một lượt đọc cũ còn bay, kết quả cũ
 *    không được ghi đè trở lại sau invalidate. Request cũ có thể hoàn tất
 *    theo góc nhìn lúc nó bắt đầu, nhưng mọi request mới phải đọc thế hệ mới.
 *
 * Loader trả null hoặc throw đều là đọc hỏng: không cache, caller fail-closed.
 */
export class PermissionGrantCache {
  private entry: PermissionCacheEntry | null = null;
  private generation = 0;
  private inFlight: {
    generation: number;
    promise: Promise<Set<string> | null>;
  } | null = null;

  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    ttlMs: number = PERMISSION_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  invalidate(): void {
    this.generation += 1;
    this.entry = null;
    // Không thể huỷ promise DB đang chạy, nhưng bỏ tham chiếu để request của
    // thế hệ mới không chờ kết quả cũ. Finalizer cũ có identity guard nên
    // không xoá nhầm lượt load mới.
    this.inFlight = null;
  }

  async getOrLoad(load: PermissionGrantLoader): Promise<Set<string> | null> {
    if (isCacheFresh(this.entry, this.now(), this.ttlMs)) {
      return this.entry!.grants;
    }

    const generation = this.generation;
    if (this.inFlight?.generation === generation) {
      return this.inFlight.promise;
    }

    const promise = (async () => {
      let grants: Set<string> | null;
      try {
        grants = await load();
      } catch {
        return null;
      }

      if (grants && this.generation === generation) {
        // Tính TTL từ lúc DB trả lời xong, không từ lúc query bắt đầu.
        this.entry = { grants, at: this.now() };
      }
      return grants;
    })().finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });

    this.inFlight = { generation, promise };
    return promise;
  }
}

/**
 * Ngăn cách trong khoá. Dùng "\u0000" chứ không phải ":" — mã vai trò hiện
 * tại không chứa ":" nhưng mã quyền có dạng "camera.setup", và nếu sau này
 * một mã nào đó chứa ":" thì ("a", "b:c") và ("a:b", "c") sẽ cho CÙNG một
 * khoá. Trên một cửa bảo vệ, nhập nhằng khoá nghĩa là cấp nhầm quyền. Ký tự
 * NUL không hợp lệ trong mã định danh nên không bao giờ đụng.
 */
const KEY_SEP = "\u0000";

/** Khoá một ô của ma trận. */
export function grantKey(role: string, permission: string): string {
  return `${role}${KEY_SEP}${permission}`;
}

/**
 * Đệm còn dùng được không. Đệm rỗng (ma trận thật sự không có dòng nào) vẫn
 * là đệm HỢP LỆ — khác hẳn `null` nghĩa là chưa đọc / đọc hỏng.
 */
export function isCacheFresh(
  cache: PermissionCacheEntry | null,
  nowMs: number,
  ttlMs: number = PERMISSION_TTL_MS,
): boolean {
  if (!cache) return false;
  return nowMs - cache.at < ttlMs;
}

/** Dựng tập khoá từ các dòng đọc được. */
export function buildGrants(
  rows: Array<{ role: string; permission_code: string }>,
): Set<string> {
  return new Set(rows.map((r) => grantKey(r.role, r.permission_code)));
}

/**
 * Tra một quyền. `null` = không đọc được ma trận → fail-closed, trả false.
 */
export function hasGrant(
  grants: Set<string> | null,
  role: string,
  permission: string,
): boolean {
  if (!grants) return false;
  return grants.has(grantKey(role, permission));
}

/** Mọi quyền của một vai trò, đã sắp xếp — cho giao diện ẩn/hiện menu. */
export function permissionsForRole(
  grants: Set<string>,
  role: string,
): string[] {
  const prefix = `${role}${KEY_SEP}`;
  return [...grants]
    .filter((g) => g.startsWith(prefix))
    .map((g) => g.slice(prefix.length))
    .sort();
}
