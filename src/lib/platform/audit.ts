import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  logPlatformAuditWith,
  type PlatformAuditEntry,
  type PlatformAuditResult,
  type PlatformAuditWriter,
} from "./audit-core";

export type { PlatformAuditEntry, PlatformAuditResult } from "./audit-core";

/**
 * Ghi audit thao tác platform-admin cross-tenant.
 *
 * KHÁC `audit_logs` (per-tenant): bảng `platform_audit_log` không có
 * `organization_id` bắt buộc; chỉ có `impersonating_org_id` (nullable —
 * null khi thao tác là platform.admin.add/remove; set khi impersonate).
 *
 * HIGH-7: hành động nhạy nhất trong SaaS = impersonate (platform vào org
 * khách). Thiếu audit = không có bằng chứng "ai vào org nào lúc nào".
 * Phải:
 *   1. Destruct `.error` (Supabase SDK KHÔNG throw khi RLS/constraint reject).
 *   2. Trả về ok/error để caller quyết fail-closed cho hành động nhạy cảm.
 *   3. Không log token/cookie/secret.
 *
 * Logic + transform ở `./audit-core.ts` (không dính `server-only` để test
 * được); file này chỉ wire `createAdminClient`.
 */
export async function logPlatformAudit(
  entry: PlatformAuditEntry,
): Promise<PlatformAuditResult> {
  const admin = createAdminClient();
  const writer: PlatformAuditWriter = {
    async insertRow(row) {
      const { error } = await admin.from("platform_audit_log").insert(row);
      return {
        error: error
          ? { code: error.code, message: error.message }
          : null,
      };
    },
  };
  return logPlatformAuditWith(writer, entry);
}
