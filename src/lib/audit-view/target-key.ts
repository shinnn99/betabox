/**
 * Khoá tra tên đối tượng của một dòng audit: `"<target_type>:<target_id>"`.
 *
 * Tách khỏi `resolve-names.ts` vì file đó mang `server-only` (dùng admin
 * client), còn khoá này cần cho cả nơi không phải server. Thuần, không
 * import gì.
 */
export interface TargetRef {
  target_type: string | null;
  target_id: string | null;
}

export function targetKey(ref: TargetRef): string | null {
  if (!ref.target_type || !ref.target_id) return null;
  return `${ref.target_type}:${ref.target_id}`;
}
