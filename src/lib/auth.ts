export type Role =
  | "owner"
  | "admin"
  | "warehouse_manager"
  | "shift_leader"
  | "packer"
  | "viewer";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Chủ sở hữu",
  admin: "Quản trị hệ thống",
  warehouse_manager: "Trưởng kho",
  shift_leader: "Trưởng ca",
  packer: "Nhân viên đóng gói",
  viewer: "Quan sát viên",
};

export const ROLE_OPTIONS: { value: Role; label: string }[] = (
  Object.keys(ROLE_LABEL) as Role[]
).map((r) => ({ value: r, label: ROLE_LABEL[r] }));

export interface Session {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  roleLabel: string;
  organizationId: string;
  organizationName: string;
  phone: string | null;
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(-2)
    .join("")
    .toUpperCase();
}
