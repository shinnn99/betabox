import {
  LayoutDashboard,
  Cpu,
  Users,
  BarChart3,
  UserCog,
  Warehouse,
  Activity,
  PackageOpen,
  FileVideo,
  ShieldCheck,
  Wrench,
  Server,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

export interface NavSection {
  id: string;
  label: string;
  children: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "main",
    label: "Tổng quan",
    children: [
      {
        id: "dashboard",
        label: "Bảng điều khiển",
        href: "/dashboard",
        icon: LayoutDashboard,
      },
    ],
  },
  {
    id: "ops",
    label: "Vận hành kho",
    children: [
      {
        id: "operations",
        label: "Giám sát đóng hàng",
        href: "/dashboard/operations",
        icon: Activity,
      },
      {
        id: "videos",
        label: "Bằng chứng giao hàng",
        href: "/dashboard/videos",
        icon: ShieldCheck,
      },
      {
        id: "returns",
        label: "Giám sát hoàn hàng",
        href: "/dashboard/returns",
        icon: PackageOpen,
      },
      {
        id: "return-videos",
        label: "Bằng chứng hoàn hàng",
        href: "/dashboard/return-videos",
        icon: FileVideo,
      },
    ],
  },
  {
    id: "manage-warehouse",
    label: "Quản lý kho",
    children: [
      {
        id: "warehouses",
        label: "Tổ chức & Kho",
        href: "/dashboard/warehouses",
        icon: Warehouse,
      },
      {
        id: "packing-stations",
        label: "Bàn đóng hàng",
        href: "/dashboard/packing-stations",
        icon: Wrench,
      },
      {
        id: "devices",
        label: "Thiết bị kho",
        href: "/dashboard/devices",
        icon: Cpu,
      },
      {
        id: "agents",
        label: "Máy trạm kho",
        href: "/dashboard/agents",
        icon: Server,
      },
      {
        id: "staff",
        label: "Nhân sự kho",
        href: "/dashboard/staff",
        icon: Users,
      },
    ],
  },
  {
    id: "reports",
    label: "Báo cáo",
    children: [
      {
        id: "reports-performance",
        label: "Báo cáo hiệu suất",
        href: "/dashboard/reports",
        icon: BarChart3,
      },
    ],
  },
  {
    id: "manage-system",
    label: "Quản lý hệ thống",
    children: [
      {
        id: "users",
        label: "Người dùng hệ thống",
        href: "/dashboard/users",
        icon: UserCog,
      },
      {
        id: "settings-warehouse-config",
        label: "Cấu hình kho",
        href: "/dashboard/settings/warehouse-config",
        icon: Settings,
      },
      // "Nhật ký hệ thống" và "Nhật ký phiên bản" đã chuyển hẳn
      // sang menu platform (chủ dự án chốt 25/09/2026) — xem
      // `src/lib/platform-nav.ts`. Cố ý KHÔNG để lại ở đây: quyết định là
      // chuyển đi, không phải nhân đôi.
    ],
  },
];

