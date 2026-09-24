/**
 * Nhật ký cập nhật phiên bản — dữ liệu cho giao diện.
 *
 * KHÔNG viết nội dung ở đây. Nội dung nằm ở phần "Phát hành cho người
 * dùng" trong các file `changelog/*.md` (chủ dự án chốt 24/09/2026: cập
 * nhật gì thì ghi vào thư mục changelog, giao diện tự đọc ra).
 * `scripts/build-changelog.mjs` đọc chúng thành `generated.ts` lúc build.
 *
 * Phân loại lớn/nhỏ: LỚN = đổi cách vận hành (một camera một máy quét →
 * hai camera; thêm luồng hàng hoàn) hoặc máy kho nhảy số giữa (0.8 → 0.9);
 * NHỎ = chỉ nhảy số cuối (0.8.1 → 0.8.2).
 */

import { GENERATED_RELEASES } from "./generated";
import type { Release, ReleaseScale } from "./types";

export type { ChangeItem, ChangeTag, Release, ReleaseScale } from "./types";

/**
 * Số cuối khác 0 (0.10.1) = chỉ vá lỗi → NHỎ.
 * Số cuối bằng 0 (0.10.0, 0.9.0) = nhảy số giữa → LỚN.
 */
export function scaleFromVersion(version: string): ReleaseScale {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return "nho";
  return parts[2] === 0 ? "lon" : "nho";
}

export function scaleOf(release: Release): ReleaseScale {
  if (release.scale) return release.scale;
  return release.agentVersion ? scaleFromVersion(release.agentVersion) : "nho";
}

/** Nhãn hiển thị cạnh tiêu đề: số máy kho, hoặc "Web" khi không đổi máy kho. */
export function badgeOf(release: Release): string {
  return release.agentVersion ? `v${release.agentVersion}` : "Web";
}

/** Mới nhất ở trên. Sinh từ `changelog/` — sửa nội dung ở đó, không sửa ở đây. */
export const RELEASES: Release[] = GENERATED_RELEASES;
