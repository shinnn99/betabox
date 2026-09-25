import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { type TargetRef } from "./target-key";

export { targetKey, type TargetRef } from "./target-key";

/**
 * Tra tên của đối tượng mà mỗi dòng audit nhắc tới (camera nào, ai, kho nào).
 *
 * Vì sao phải tra ở server: metadata của `audit_logs` KHÔNG nhất quán —
 * một số route chụp lại `full_name`/`staff_code` trước khi xoá, phần lớn chỉ
 * lưu `target_id` trần. Không tra thì trang hiện UUID cắt 8 ký tự, người đọc
 * không biết đó là camera nào.
 *
 * Ranh giới bảo mật: file này chỉ phục vụ trang platform (xem xuyên kho) nên
 * dùng admin client, bỏ RLS. Cổng chặn nằm ở route — `requirePlatformRole`
 * phải đứng TRƯỚC `createAdminClient()`. Đừng gọi từ route tenant: lộ tên
 * đối tượng cross-tenant cũng là rò dữ liệu, dù "chỉ là cái tên".
 *
 * Đối tượng đã bị xoá thì không tra ra — trả về không có tên, phía trình bày
 * tự lùi về tên chụp trong metadata (xem `presenter.resolveTargetLabel`).
 */

/** target_type → bảng + cột dựng tên. Cột lấy từ schema thật (25/09/2026). */
const SOURCES = {
  camera: { table: "cameras", columns: "id, name, camera_code" },
  user: { table: "user_profiles", columns: "id, full_name" },
  staff: { table: "staff_profiles", columns: "id, full_name, staff_code" },
  warehouse: { table: "warehouses", columns: "id, name, code" },
  packing_station: { table: "packing_stations", columns: "id, name, code" },
  station_device: { table: "station_devices", columns: "id, name" },
  warehouse_agent: { table: "warehouse_agents", columns: "id, name, code" },
} as const;

type ResolvableType = keyof typeof SOURCES;

function isResolvable(t: string | null): t is ResolvableType {
  return t !== null && t in SOURCES;
}

interface NameRow {
  id: string;
  name?: string | null;
  full_name?: string | null;
  code?: string | null;
  camera_code?: string | null;
  staff_code?: string | null;
  [k: string]: unknown;
}

/** Tên hiển thị từ một hàng: tên trước, mã làm chỗ dựa khi tên trống. */
function displayName(row: NameRow): string | null {
  const primary = row.name ?? row.full_name;
  if (typeof primary === "string" && primary.trim()) return primary.trim();
  const code = row.code ?? row.camera_code ?? row.staff_code;
  if (typeof code === "string" && code.trim()) return code.trim();
  return null;
}

/**
 * `audit_logs.target_id` là `text`, còn `id` của các bảng đích là `uuid`.
 * Một giá trị không phải UUID lọt vào `.in("id", ...)` làm Postgres ném
 * 22P02 và CẢ NHÓM mất tên, không riêng dòng hỏng. Dữ liệu hiện tại sạch
 * (kiểm 25/09/2026) nhưng kiểu cột không chặn được route tương lai ghi bậy.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trả map `"<type>:<id>" → tên`. Gom theo bảng nên tối đa 7 truy vấn cho cả
 * trang, không phải mỗi dòng một truy vấn.
 *
 * Một bảng lỗi (RLS chặn, bảng đổi tên) KHÔNG làm hỏng cả trang: bỏ qua
 * nhóm đó, các nhóm khác vẫn có tên. Nhật ký vẫn đọc được, chỉ thiếu tên.
 */
/** Gom id cần tra theo từng bảng. Dùng chung cho cả hai biến thể dưới. */
function groupIdsByType(
  rows: readonly TargetRef[],
): Map<ResolvableType, Set<string>> {
  const idsByType = new Map<ResolvableType, Set<string>>();
  for (const r of rows) {
    if (!isResolvable(r.target_type) || !r.target_id) continue;
    if (!UUID_RE.test(r.target_id)) continue;
    const set = idsByType.get(r.target_type) ?? new Set<string>();
    set.add(r.target_id);
    idsByType.set(r.target_type, set);
  }
  return idsByType;
}

/** Nhặt tên từ kết quả một bảng vào map chung. */
function collectNames(
  out: Map<string, string>,
  type: ResolvableType,
  data: unknown,
): void {
  for (const row of (data ?? []) as NameRow[]) {
    const label = displayName(row);
    if (label) out.set(`${type}:${row.id}`, label);
  }
}

/**
 * Tra tên xuyên mọi tổ chức bằng admin client.
 *
 * Vì sao được phép bỏ RLS: người gọi là quản trị nền tảng, đã qua
 * `requirePlatformRole`, và việc của trang là xem xuyên kho. Ranh giới nằm
 * ở route (ai vào được), không nằm ở đây — nên route nào dùng hàm này thì
 * `requirePlatformRole` PHẢI đứng trước `createAdminClient()`.
 *
 * Chỉ dùng cho `/api/platform/*`. Nếu sau này trả trang nhật ký về cho chủ
 * kho thì viết biến thể đi qua `scoped.select` (RLS đỡ), đừng dùng hàm này.
 */
export async function resolveTargetNamesAdmin(
  admin: ReturnType<typeof createAdminClient>,
  rows: readonly TargetRef[],
): Promise<Map<string, string>> {
  const idsByType = groupIdsByType(rows);
  const out = new Map<string, string>();

  await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const source = SOURCES[type];
      const { data, error } = await admin
        .from(source.table)
        .select(source.columns)
        .in("id", [...ids]);

      if (error) {
        console.error(
          `[audit-view] tra tên (platform) thất bại type=${type} code=${error.code ?? "?"} message=${error.message}`,
        );
        return;
      }
      collectNames(out, type, data);
    }),
  );

  return out;
}
