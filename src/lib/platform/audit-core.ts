/**
 * Pure/no-side-effect core của platform audit — tách khỏi `audit.ts`
 * (file kia có `import "server-only"` không import được từ test node).
 *
 * `audit.ts` chỉ còn wrapper createAdminClient + writer implement, phần
 * logic transform + destruct .error ở đây → test được không cần Supabase.
 */

export interface PlatformAuditEntry {
  actorUserId: string;
  actorEmail?: string | null;
  impersonatingOrgId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PlatformAuditResult {
  ok: boolean;
  error?: string;
}

export interface PlatformAuditWriter {
  insertRow(
    row: Record<string, unknown>,
  ): Promise<{ error: { code?: string; message: string } | null }>;
}

export function buildAuditRow(
  entry: PlatformAuditEntry,
): Record<string, unknown> {
  return {
    actor_user_id: entry.actorUserId,
    actor_email: entry.actorEmail ?? null,
    impersonating_org_id: entry.impersonatingOrgId ?? null,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    metadata: entry.metadata ?? null,
  };
}

export async function logPlatformAuditWith(
  writer: PlatformAuditWriter,
  entry: PlatformAuditEntry,
): Promise<PlatformAuditResult> {
  const row = buildAuditRow(entry);
  const { error } = await writer.insertRow(row);
  if (error) {
    console.error(
      `[platform_audit_log] insert failed action=${entry.action} code=${error.code ?? "?"} message=${error.message}`,
    );
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
