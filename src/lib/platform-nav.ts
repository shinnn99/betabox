import { Building2, Users, ScrollText, type LucideIcon } from "lucide-react";

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
];
