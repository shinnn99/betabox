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

/**
 * "Database chưa có hàm RPC này" — migration tạo hàm chưa chạy. Cùng lý do
 * với cột: mã mới lùi về đường cũ thay vì gãy.
 *
 *   - PostgREST `PGRST202` "Could not find the function public.x(...) in the
 *     schema cache"
 *   - Postgres `42883` "function x(...) does not exist"
 *
 * Khớp theo TÊN hàm, như cột.
 */
export function isMissingFunctionError(error: ColumnQueryError | null | undefined, fn: string): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  const shapeMatches =
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /could not find the function|function .* does not exist/i.test(message);
  return shapeMatches && message.includes(fn);
}
