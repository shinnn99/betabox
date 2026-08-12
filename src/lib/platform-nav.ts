import { Building2, Users, ScrollText, Activity, type LucideIcon } from "lucide-react";

export interface PlatformNavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

export const PLATFORM_NAV: PlatformNavItem[] = [
  {
    id: "orgs",
    label: "Tổ chức",
    href: "/platform",
    icon: Building2,
  },
  {
    id: "admins",
    label: "Quản trị nền tảng",
    href: "/platform/admins",
    icon: Users,
  },
  {
    id: "audit",
    label: "Nhật ký kiểm toán",
    href: "/platform/audit",
    icon: ScrollText,
  },
  // Chỉ có trong menu platform: dữ liệu hạ tầng nội bộ Betacom (ổ đĩa VPS,
  // agent của MỌI kho, camera của MỌI khách). Menu tenant không có mục này,
  // và API /api/system/status chặn lần hai bằng requirePlatformRole.
  {
    id: "system",
    label: "Tình trạng hệ thống",
    href: "/platform/system",
    icon: Activity,
  },
];
