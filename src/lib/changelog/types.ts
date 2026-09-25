/**
 * Kiểu dữ liệu của Nhật ký phiên bản.
 *
 * Nội dung THẬT nằm ở phần "Phát hành cho người dùng" trong các file
 * `changelog/*.md`; `scripts/build-changelog.mjs` đọc ra `generated.json`
 * lúc build. Tách kiểu ra file riêng để bộ đọc (parse.ts) dùng được mà
 * không kéo theo dữ liệu.
 */

export type ChangeTag = "Mới" | "Sửa lỗi" | "Cải tiến";

export interface ChangeItem {
  tag: ChangeTag;
  title: string;
  detail: string;
}

export type ReleaseScale = "lon" | "nho";

export interface Release {
  /** Số máy kho ("0.12.0") hoặc null khi chỉ đổi phần trên web. */
  agentVersion: string | null;
  /** Ngày phát hành, dạng YYYY-MM-DD. */
  date: string;
  title: string;
  summary: string;
  /**
   * Bỏ trống thì suy từ số máy kho. Đặt tay cho những lần chỉ đổi phần
   * trên web mà vẫn đổi cách vận hành.
   */
  scale?: ReleaseScale;
  items: ChangeItem[];
}
