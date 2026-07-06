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
  /**
   * B1.2 immutable snapshot fields. Caller supply tại thời điểm audit
   * event; nếu không supply, snapshot = null hoặc self-copy phù hợp.
   * Bảo toàn identity information khi FK SET NULL (org bị xóa).
   */
  organizationNameSnapshot?: string | null;
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
 *
 * B1.2: ghi snapshot organization_id_snapshot (self-copy) + optional
 * organization_name_snapshot. Bảo toàn identity khi FK SET NULL sau org
 * bị xóa (migration 20260707160000).
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
    // B1.2 snapshot fields
    organization_id_snapshot: entry.organizationId,
    organization_name_snapshot: entry.organizationNameSnapshot ?? null,
  });
  if (error) {
    console.error(
      `[audit] insert failed org=${entry.organizationId} action=${entry.action} code=${error.code ?? "?"} message=${error.message}`,
    );
  }
}
