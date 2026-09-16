/**
 * Các cột định danh camera theo MAC chỉ tồn tại sau migration
 * `20260916120000_camera_mac_identity.sql`.
 *
 * Vì sao cần lớp lùi này: mã nguồn và migration không lên cùng một lúc.
 * Ngày 16/09/2026 việc đó xảy ra thật — cloud hỏi `cameras.mac_address`
 * trên một database chưa có cột, PostgREST trả lỗi, `active_cameras`
 * lookup hỏng, và agent mất danh sách camera cần ghi. Một tính năng phụ
 * (nhớ MAC) làm gãy nghiệp vụ chính (ghi bằng chứng) là cái giá không
 * chấp nhận được.
 *
 * Nên: thiếu cột thì truy vấn tự lùi về danh sách cột cũ và kêu một lần,
 * chứ không ném lỗi. Tính năng tự dò lại IP sẽ nằm im cho tới khi áp
 * migration — đúng như mong đợi, vì không có MAC thì không có gì để đối
 * chiếu.
 */

const MAC_COLUMNS = [
  "mac_address",
  "onvif_uuid",
  "ip_last_changed_at",
  "ip_auto_healed_count",
];

/** Postgres: undefined_column. */
const UNDEFINED_COLUMN = "42703";

let warned = false;

export interface QueryError {
  code?: string | null;
  message?: string | null;
}

export function isMissingMacColumn(error: QueryError | null): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  if (error.code === UNDEFINED_COLUMN || /does not exist/i.test(message)) {
    return MAC_COLUMNS.some((column) => message.includes(column));
  }
  return false;
}

/** Bỏ các cột MAC khỏi một danh sách select dạng "a, b, c". */
export function withoutMacColumns(columns: string): string {
  return columns
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column.length > 0 && !MAC_COLUMNS.includes(column))
    .join(", ");
}

/**
 * Chạy một truy vấn `cameras`; nếu database chưa có cột MAC thì chạy lại
 * với danh sách cột cũ.
 *
 * `build` phải dựng lại truy vấn từ đầu mỗi lần gọi — query builder của
 * Supabase không dùng lại được sau khi đã await.
 */
export async function selectCamerasWithMacFallback<T>(
  columns: string,
  build: (
    columns: string,
  ) => PromiseLike<{ data: T; error: QueryError | null }>,
): Promise<{ data: T; error: QueryError | null }> {
  const first = await build(columns);
  if (!isMissingMacColumn(first.error)) return first;

  if (!warned) {
    warned = true;
    console.warn(
      "[camera] database chưa có cột MAC — bỏ qua phần định danh theo MAC. " +
        "Áp migration 20260916120000_camera_mac_identity.sql để bật lại tính năng tự dò IP.",
    );
  }
  return build(withoutMacColumns(columns));
}
