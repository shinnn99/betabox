import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export type PlatformRole = "platform_owner" | "platform_support";

export interface PlatformAdminInfo {
  isPlatform: true;
  platformRole: PlatformRole;
}

/**
 * Lớp B của 3 lớp guard tin cậy — nguồn duy nhất "ai là platform admin".
 * Dùng chung cho proxy.ts (khối 2 impersonate) và guard.ts (readClaims).
 *
 * Contract:
 *   - Nhận `userId` từ caller (đã đọc từ session server-side verify chữ ký).
 *     KHÔNG tự đọc session — tách auth (caller) khỏi authz (hàm này).
 *     KHÔNG tin uid client-truyền — caller đảm bảo uid từ nguồn tin cậy.
 *   - Query bảng `platform_admins` bằng service role (bypass RLS default-deny).
 *   - KHÔNG cache — revoke-ngay kill-switch: xóa row/set status='disabled'
 *     → user mất quyền ngay request kế, không chờ token hết hạn.
 *   - Filter `status='active'` — disabled = như không tồn tại.
 *
 * Note về `.maybeSingle()`: AN TOÀN ở đây vì `id` là PRIMARY KEY của
 * platform_admins (tối đa 1 row per uid). maybeSingle() throw nếu >1 row —
 * với PK không thể xảy ra. Phân biệt với ca không-PK (ví dụ warehouse_agents
 * query theo cột không unique) — chỗ đó phải dùng .limit(1) + data[0] để
 * tránh maybeSingle throw. Đừng copy pattern này sang chỗ không-PK.
 */
export async function checkPlatformAdmin(
  userId: string
): Promise<PlatformAdminInfo | null> {
  if (!userId) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("platform_admins")
    .select("role, status")
    .eq("id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!data) return null;
  return {
    isPlatform: true,
    platformRole: data.role as PlatformRole,
  };
}
