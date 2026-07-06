import "server-only";
import { createAdminClient } from "./supabase/admin";

export interface AuditEntry {
  organizationId: string;
  actorUserId: string;
  actorEmail?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Ghi log thao tác quản trị.
 *
 * HIGH-15: Supabase SDK KHÔNG throw khi RLS/constraint reject — nó trả
 * `{ data, error }`. Try/catch chỉ bắt lỗi mạng; RLS reject → silent
 * fail, mất bằng chứng. Phải destruct `.error` và log message + code
 * để ops thấy.
 *
 * Chính sách: audit_logs per-tenant là "audit-critical" nhưng không
 * fail-closed nghiệp vụ chính (audit fail không được rollback business
 * write đã xảy ra). Log message + code ra console, KHÔNG log metadata
 * raw (chống rò dữ liệu tenant vào Vercel logs cross-tenant).
 */
export async function audit(entry: AuditEntry): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_logs").insert({
    organization_id: entry.organizationId,
    actor_user_id: entry.actorUserId,
    actor_email: entry.actorEmail ?? null,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
  });
  if (error) {
    console.error(
      `[audit] insert failed org=${entry.organizationId} action=${entry.action} code=${error.code ?? "?"} message=${error.message}`,
    );
  }
}
