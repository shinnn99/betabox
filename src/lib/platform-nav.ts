import {
  Building2,
  Users,
  ScrollText,
  Activity,
  Warehouse,
  Sparkles,
  HardDrive,
  Server,
  Siren,
  SlidersHorizontal,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export interface PlatformNavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

export interface PlatformNavSection {
  id: string;
  label: string;
  children: PlatformNavItem[];
}

/**
 * Menu platform chia theo ĐỐI TƯỢNG đang quản, không gom hết vào một nhãn
 * "Quản trị" (chủ dự án chốt 02/10/2026). Bốn nhóm, mỗi nhóm trả lời một câu
 * khác nhau:
 *
 *   Khách hàng       — ai đang dùng hệ, cấu hình và quyền của họ ra sao
 *   Hạ tầng vận hành — máy móc Betacom đang chạy có khoẻ không
 *   Nội bộ nền tảng  — người và phiên bản của chính Betacom
 *   Nhật ký          — chuyện đã xảy ra, tra lại khi cần
 *
 * Cấu trúc section mirror `src/lib/nav.ts` của menu kho, nên PlatformShell và
 * DashboardSidebar render cùng một kiểu.
 */
export const PLATFORM_NAV_SECTIONS: PlatformNavSection[] = [
  {
    id: "customers",
    label: "Khách hàng",
    children: [
      {
        id: "orgs",
        label: "Tổ chức",
        href: "/platform",
        icon: Building2,
      },
      // Đợt 4 (VAN-HANH-NHIEU-KHO): cấu hình mọi kho trên một màn hình —
      // không phải đóng giả vào từng tổ chức.
      {
        id: "config",
        label: "Cấu hình các kho",
        href: "/platform/config",
        icon: SlidersHorizontal,
      },
      // Ma trận RBAC này phân quyền cho vai trò TRONG kho (owner, admin,
      // packer...), nên thuộc nhóm khách hàng — không phải quyền của quản trị
      // nền tảng. Quyền platform_owner / platform_support nằm ở mục "Quản trị
      // nền tảng" bên nhóm nội bộ.
      {
        id: "permissions",
        label: "Phân quyền",
        href: "/platform/permissions",
        icon: ShieldCheck,
      },
    ],
  },
  {
    id: "infrastructure",
    label: "Hạ tầng vận hành",
    children: [
      // Dữ liệu hạ tầng nội bộ Betacom (ổ đĩa VPS, agent của MỌI kho, camera
      // của MỌI khách). Menu tenant không có mục này, và API
      // /api/system/status chặn lần hai bằng requirePlatformRole.
      {
        id: "system",
        label: "Tình trạng hệ thống",
        href: "/platform/system",
        icon: Activity,
      },
      // Đợt 4: nơi LÀM VIỆC với sổ sự cố của mọi kho.
      {
        id: "incidents",
        label: "Sự cố",
        href: "/platform/incidents",
        icon: Siren,
      },
      // Đợt 7: mọi máy kho một màn hình — phiên bản, camera ghi, ổ đĩa, hàng đợi.
      {
        id: "agents",
        label: "Đội agent",
        href: "/platform/agents",
        icon: Server,
      },
      // Dung lượng video trên Supabase Storage (02/10/2026). Thuộc nhóm hạ
      // tầng chứ không phải nhóm khách hàng: bucket là tài nguyên Betacom trả
      // tiền, và con số ở đó là CACHE 72h — không phải kho bằng chứng của kho.
      {
        id: "storage",
        label: "Dung lượng video",
        href: "/platform/storage",
        icon: HardDrive,
      },
    ],
  },
  {
    id: "internal",
    label: "Nội bộ nền tảng",
    children: [
      {
        id: "admins",
        label: "Quản trị nền tảng",
        href: "/platform/admins",
        icon: Users,
      },
      // Nội dung sinh từ thư mục `changelog/` lúc build, KHÔNG phụ thuộc tổ
      // chức — là phiên bản của chính Betacom, nên để ở nhóm nội bộ.
      {
        id: "changelog",
        label: "Nhật ký phiên bản",
        href: "/platform/changelog",
        icon: Sparkles,
      },
    ],
  },
  {
    id: "audit",
    label: "Nhật ký",
    children: [
      // Hai mục này đọc HAI BẢNG khác nhau, cố ý không gộp:
      //   "Nhật ký kiểm toán" → `platform_audit_log`, việc quản trị nền tảng làm
      //   "Nhật ký các kho"   → `audit_logs`, việc người TRONG kho làm
      // (Mục "Nhật ký các kho" chuyển từ dashboard kho sang, chủ dự án chốt
      // 25/09/2026.)
      {
        id: "audit",
        label: "Nhật ký kiểm toán",
        href: "/platform/audit",
        icon: ScrollText,
      },
      {
        id: "org-audit",
        label: "Nhật ký các kho",
        href: "/platform/org-audit",
        icon: Warehouse,
      },
    ],
  },
];

/** Danh sách phẳng — dùng cho tra cứu theo href, không dùng để render menu. */
export const PLATFORM_NAV: PlatformNavItem[] = PLATFORM_NAV_SECTIONS.flatMap(
  (section) => section.children,
);
