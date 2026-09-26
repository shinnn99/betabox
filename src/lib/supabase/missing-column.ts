/**
 * "Database chưa có cột này" — để mã mới chạy được trên database chưa áp
 * migration, thay vì gãy nghiệp vụ chính vì một tính năng phụ.
 *
 * Tiền lệ: 16/09/2026 cloud hỏi `cameras.mac_address` trên database chưa có
 * cột, agent mất danh sách camera cần ghi (xem src/lib/camera/mac-columns.ts).
 *
 * Hai dạng lỗi, tuỳ đường:
 *   - đọc (select / lọc): Postgres `42703` "column x does not exist"
 *   - ghi (insert / update): PostgREST `PGRST204` "Could not find the 'x'
 *     column of 't' in the schema cache"
 *
 * Luôn khớp theo TÊN cột: một lỗi thiếu cột KHÁC không được nuốt nhầm.
 */
export interface ColumnQueryError {
  code?: string | null;
  message?: string | null;
}

export function isMissingColumnError(error: ColumnQueryError | null | undefined, column: string): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  const shapeMatches =
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /does not exist|could not find the .* column/i.test(message);
  return shapeMatches && message.includes(column);
}
