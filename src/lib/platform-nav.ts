import {
  Building2,
  Users,
  ScrollText,
  Activity,
  Warehouse,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

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
  // Hai mục dưới chuyển từ dashboard kho sang (chủ dự án chốt 25/09/2026).
  //
  // "Nhật ký các kho" đọc `audit_logs` — việc người TRONG kho làm; khác
  // "Nhật ký kiểm toán" ở trên vốn đọc `platform_audit_log` — việc quản trị
  // nền tảng làm. Hai bảng, hai cột, nên để hai mục chứ không gộp.
  {
    id: "org-audit",
    label: "Nhật ký các kho",
    href: "/platform/org-audit",
    icon: Warehouse,
  },
  {
    id: "changelog",
    label: "Nhật ký phiên bản",
    href: "/platform/changelog",
    icon: Sparkles,
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
