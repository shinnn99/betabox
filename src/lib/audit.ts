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
 * Ghi log thao tác quản trị. Không throw — log lỗi ra console nếu fail
 * (audit không được làm hỏng nghiệp vụ chính).
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from("audit_logs").insert({
      organization_id: entry.organizationId,
      actor_user_id: entry.actorUserId,
      actor_email: entry.actorEmail ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    console.error("[audit] failed:", err);
  }
}
