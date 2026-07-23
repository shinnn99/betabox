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

// Rank cao = quyền cao. Dùng để chặn leo thang: actor không được thao tác
// (tạo/hạ/lên) target có rank >= actor, trừ khi actor là owner.
// Owner có full power (kể cả cấp owner khác — chỉ chặn ở tầng "last owner"
// riêng, không phải ở đây).
const ROLE_RANK: Record<Role, number> = {
  owner: 100,
  admin: 80,
  warehouse_manager: 60,
  shift_leader: 40,
  packer: 20,
  viewer: 10,
};

/**
 * Chặn leo thang: actor có được phép set target sang `targetRole` không?
 *
 * Rule (chốt 2026-07-23 sau bug POST /api/users cho phép admin tạo owner):
 *   - Owner: full power. Cấp owner khác được (last-owner check tầng khác).
 *   - Actor khác: chỉ set được target role có rank THẤP HƠN mình. Bằng hoặc
 *     cao hơn = từ chối.
 *
 * Ví dụ:
 *   canAssignRole('owner', 'admin') = true (owner cấp admin ok)
 *   canAssignRole('admin', 'owner') = false (admin cấp owner = leo thang)
 *   canAssignRole('admin', 'admin') = false (admin cấp admin = ngang hàng, chặn)
 *   canAssignRole('admin', 'warehouse_manager') = true
 *   canAssignRole('warehouse_manager', 'packer') = false (WM không có user.create,
 *     nên hàm này không bao giờ được gọi cho WM — nhưng nếu gọi vẫn chặn)
 */
export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "owner") return true;
  return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
}
