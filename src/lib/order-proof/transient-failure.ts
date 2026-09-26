/**
 * Clip bằng chứng — phân loại lỗi TẠM THỜI của lần cắt trước.
 *
 * Tách khỏi route `/watch` vì file route của Next.js chỉ được xuất GET/POST
 * và cấu hình route.
 */
/**
 * Lỗi "đoạn cuối chưa đóng" là tạm thời — ghi bởi bản trước 26/09/2026. Khớp
 * theo đầu câu tiếng Việt đã ghi vào `order_proof_clips.error_message`.
 */
export function isTransientSegmentFailure(message: string | null | undefined): boolean {
  return typeof message === "string" && message.startsWith("Segment cuối chưa đóng");
}
