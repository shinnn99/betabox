// ============================================================================
// render-org-guard — Lõi quyết định của vế 4 (chống ghi-nhầm org).
//
// Tách khỏi guard.ts để test được thuần túy: không `server-only`, không
// next/headers, không Supabase client. guard.ts giữ phần lấy header + dựng
// NextResponse; file này chỉ trả lời MỘT câu hỏi:
//
//     "Request này được ghi, bị chặn, hay không phải request ghi?"
//
// ── Vì sao fail-CLOSED (2026-09-16) ─────────────────────────────────────────
// Bản cũ fail-OPEN: vắng `x-render-org-id` → cho qua, vì giả định "chỉ GET mới
// thiếu header" (client wrapper luôn gắn cho POST/PUT/DELETE).
//
// Giả định đó sai. Rà 2026-09-16: 41/49 điểm ghi trong dashboard gọi `fetch`
// trần thay vì `apiFetch`, nên header vắng ở request GHI — đúng lớp request mà
// vế 4 sinh ra để bảo vệ. Hệ quả thật: 2026-09-16 03:20, một tab mở sẵn org
// Đại Kim nhận thao tác nhắm vào org Demo; camera `dahua_01` của kho thật bị
// ghi đè 8 trường (mã, IP, tên, mật khẩu), kho mất ghi hình ~24 giờ.
//
// Guard KHÔNG suy được method từ việc header có mặt hay không — đó chính là
// vòng luẩn quẩn khiến lỗ tồn tại. Nên method giờ là tham số tường minh, đọc
// từ request thật:
//
//   - method đọc  (GET/HEAD/OPTIONS) → bỏ qua, header không bắt buộc.
//   - method ghi  + header khớp      → cho ghi.
//   - method ghi  + header lệch      → chặn (tab cũ, org đã đổi).
//   - method ghi  + header vắng      → CHẶN. Không đoán là "chắc an toàn".
//
// Nhánh cuối là thay đổi hành vi: mọi client ghi BẮT BUỘC đi qua `apiFetch`.
// Đổi lại, lỗ không thể tái mở bằng cách quên một lời gọi — quên thì vỡ ngay
// ở dev, không im lặng ghi nhầm org khách hàng.
// ============================================================================

/** Method không đổi trạng thái → không cần chứng minh ngữ cảnh org. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type RenderOrgVerdict =
  | { kind: "skip" }
  | { kind: "allow" }
  | { kind: "mismatch" }
  | { kind: "missing" };

export function isWriteMethod(method: string | null | undefined): boolean {
  if (!method) return false;
  return !READ_METHODS.has(method.toUpperCase());
}

/**
 * Quyết định cho một request.
 *
 * @param method        HTTP method thật của request.
 * @param renderOrgId   Giá trị `x-render-org-id` (org mà TRANG được render ra).
 * @param contextOrgId  Org mà request SẮP GHI VÀO (sau verify token/JWT).
 */
export function evaluateRenderOrg(
  method: string | null | undefined,
  renderOrgId: string | null | undefined,
  contextOrgId: string,
): RenderOrgVerdict {
  if (!isWriteMethod(method)) return { kind: "skip" };

  // Chuỗi rỗng ≠ "có header". Layout nhúng "" khi không giải được org; coi
  // như vắng để không lọt qua bằng một giá trị vô nghĩa.
  const rendered = renderOrgId?.trim();
  if (!rendered) return { kind: "missing" };

  return rendered === contextOrgId ? { kind: "allow" } : { kind: "mismatch" };
}
