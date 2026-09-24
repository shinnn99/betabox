/**
 * Quyền cần để thấy từng mục menu dashboard (và được vào trang đó).
 *
 * Tách khỏi nav.ts vì nav.ts kéo theo icon (lucide-react), không import
 * được ở test/server. Thứ tự giữ đúng thứ tự menu: trang đầu tiên được vào
 * là nơi đưa người dùng tới khi trang chủ bị cấm.
 *
 * Chỉ để HIỂN THỊ — API của từng trang vẫn tự kiểm quyền.
 */
export type CanFn = (anyOf: string[]) => boolean;

/** [href, cần ÍT NHẤT MỘT quyền trong danh sách] */
export const NAV_ACCESS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["/dashboard", ["report.view"]],
  ["/dashboard/operations", ["warehouse.view"]],
  ["/dashboard/videos", ["order_proof.view"]],
  ["/dashboard/returns", ["warehouse.view"]],
  ["/dashboard/return-videos", ["order_proof.view"]],
  ["/dashboard/warehouses", ["packing_station.view"]],
  ["/dashboard/packing-stations", ["packing_station.view"]],
  // Thiết bị kho: ai xem được thiết bị đều vào được (Trưởng kho chỉ xem —
  // trang tự ẩn nút thêm/sửa/xoá/đổi bàn theo quyền). Viewer không thấy.
  ["/dashboard/devices", ["station_device.view"]],
  // Máy trạm kho: ai xem được thiết bị đều xem được trạng thái máy trạm;
  // tạo / cấp secret / xoá chặn ngay ở nút (station_device.create).
  ["/dashboard/agents", ["station_device.view"]],
  ["/dashboard/staff", ["staff.view"]],
  ["/dashboard/reports", ["report.view"]],
  ["/dashboard/users", ["user.view"]],
  ["/dashboard/settings/warehouse-config", ["warehouse.update"]],
  ["/dashboard/audit", ["audit.view"]],
  // Nhật ký cập nhật phiên bản: cùng nhóm Quản lý hệ thống nên cùng quyền
  // với Nhật ký hệ thống — chủ sở hữu, admin, trưởng kho.
  ["/dashboard/settings/changelog", ["audit.view"]],
];

const BY_HREF = new Map(NAV_ACCESS.map(([h, a]) => [h, a]));

/** Mục menu chưa khai quyền thì ẩn — thà thiếu một mục còn hơn hở một trang. */
export function canSeeHref(href: string, can: CanFn): boolean {
  const anyOf = BY_HREF.get(href);
  return anyOf ? can([...anyOf]) : false;
}

/** Mục menu ứng với đường dẫn (khớp dài nhất); không thuộc menu → null. */
export function navHrefForPath(pathname: string): string | null {
  let best: string | null = null;
  for (const [href] of NAV_ACCESS) {
    const hit =
      href === "/dashboard"
        ? pathname === "/dashboard"
        : pathname === href || pathname.startsWith(href + "/");
    if (hit && (!best || href.length > best.length)) best = href;
  }
  return best;
}

/** Trang đầu tiên (theo thứ tự menu) người dùng được vào. */
export function firstAllowedHref(can: CanFn): string | null {
  return NAV_ACCESS.find(([, anyOf]) => can([...anyOf]))?.[0] ?? null;
}
