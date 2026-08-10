import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export type PlatformRole = "platform_owner" | "platform_support";

export interface PlatformAdminInfo {
  isPlatform: true;
  platformRole: PlatformRole;
}

/**
 * Không kết luận được "có phải platform admin không" — service key sai, mạng
 * đứt, Supabase 5xx.
 *
 * Đây KHÔNG phải "không phải platform admin". Gộp hai thứ này là gốc của sự
 * cố 10/08/2026: service key trên Vercel bị từ chối (401), mọi lượt kiểm trả
 * về "không phải platform" một cách im lặng, nên platform owner bị đẩy vào
 * dashboard tenant kèm banner "User chưa được gán organization" — đọc như
 * tài khoản hỏng, trong khi thứ hỏng là hạ tầng.
 */
export class PlatformAdminCheckError extends Error {
  constructor(cause: string) {
    super(`platform_admins check unavailable: ${cause}`);
    this.name = "PlatformAdminCheckError";
  }
}

export type PlatformAdminVerdict =
  | { kind: "platform"; platformRole: PlatformRole }
  | { kind: "not_platform" }
  | { kind: "unavailable"; cause: string };

/**
 * Diễn giải kết quả truy vấn thành BA trạng thái, không phải hai.
 *
 * Tách riêng khỏi phần gọi mạng để test được không cần env/DB — chính chỗ
 * này là nơi lỗi 10/08 nằm, nên nó phải có test.
 *
 * LƯU Ý supabase-js KHÔNG throw khi HTTP 401/5xx: nó trả `{ data: null,
 * error }`. Viết `const { data } = await ...` là bỏ rơi `error`, và mọi hỏng
 * hóc hạ tầng lặng lẽ biến thành "không phải platform admin". Luôn đọc cả
 * hai giá trị.
 */
export function interpretPlatformAdminResult(
  data: { role?: string | null } | null,
  error: { message?: string; code?: string } | null,
): PlatformAdminVerdict {
  if (error) {
    return {
      kind: "unavailable",
      cause: `${error.code ?? "?"} ${error.message ?? "unknown"}`.trim(),
    };
  }
  if (!data) return { kind: "not_platform" };
  if (data.role !== "platform_owner" && data.role !== "platform_support") {
    // Hàng có thật nhưng role lạ (migration lệch, dữ liệu tay). Không đoán
    // bừa thành platform admin, cũng không im lặng bỏ qua.
    return { kind: "unavailable", cause: `unknown_role:${String(data.role)}` };
  }
  return { kind: "platform", platformRole: data.role };
}

/**
 * Lớp B của 3 lớp guard tin cậy — nguồn duy nhất "ai là platform admin".
 * Dùng chung cho proxy.ts (khối 2 impersonate), src/lib/supabase/proxy.ts
 * (định tuyến sau đăng nhập) và guard.ts (readClaims).
 *
 * Contract:
 *   - Nhận `userId` từ caller (đã đọc từ session server-side verify chữ ký).
 *     KHÔNG tự đọc session — tách auth (caller) khỏi authz (hàm này).
 *     KHÔNG tin uid client-truyền — caller đảm bảo uid từ nguồn tin cậy.
 *   - Query bảng `platform_admins` bằng service role (bypass RLS default-deny).
 *   - KHÔNG cache — revoke-ngay kill-switch: xóa row/set status='disabled'
 *     → user mất quyền ngay request kế, không chờ token hết hạn.
 *   - Filter `status='active'` — disabled = như không tồn tại.
 *   - Trả `null` CHỈ khi chắc chắn không phải platform admin.
 *     THROW `PlatformAdminCheckError` khi không kết luận được — caller phải
 *     xử lý riêng, không được coi như "không phải platform admin".
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

  let data: { role: string | null } | null = null;
  let error: { message?: string; code?: string } | null = null;
  try {
    const admin = createAdminClient();
    const res = await admin
      .from("platform_admins")
      .select("role, status")
      .eq("id", userId)
      .eq("status", "active")
      .maybeSingle();
    data = res.data as { role: string | null } | null;
    error = res.error;
  } catch (e) {
    // createAdminClient throw khi thiếu env; fetch throw khi mạng đứt.
    error = { message: (e as Error).message, code: "throw" };
  }

  const verdict = interpretPlatformAdminResult(data, error);
  if (verdict.kind === "unavailable") {
    console.error(
      `[platform-admin-check] KHONG XAC DINH DUOC userId=${userId} cause=${verdict.cause}`,
    );
    throw new PlatformAdminCheckError(verdict.cause);
  }
  if (verdict.kind === "not_platform") return null;
  return { isPlatform: true, platformRole: verdict.platformRole };
}
