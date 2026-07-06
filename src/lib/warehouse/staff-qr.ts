import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * QR format đang dùng trong production:
 *   <organization_id>.<staff_id>.<rawToken>
 *
 * organization_id và staff_id đều là UUID v4. rawToken là base64url 32 byte
 * (xem src/lib/qr.ts → issueStaffQr). KHÔNG dùng prefix "STAFF_CHECKIN:".
 */

// Permissive UUID-shape: 8-4-4-4-12 hex. We do NOT enforce v4 variant bits
// here because (a) some seeded orgs use non-RFC4122 UUIDs, and (b) the real
// authentication happens via token_hash lookup against the DB — so loose
// parsing is safe, while a strict regex would silently reject real QRs.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// rawToken là 32 bytes base64url → ~43 ký tự alphabet [A-Za-z0-9_-].
// Cho phép 16+ để chấp nhận biến thể trong tương lai mà vẫn loại được waybill.
const STAFF_QR_RE = new RegExp(`^(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{16,})$`, "i");

export interface ParsedStaffQr {
  organizationId: string;
  staffId: string;
  rawToken: string;
}

export function tryParseStaffQr(raw: string): ParsedStaffQr | null {
  const m = STAFF_QR_RE.exec(raw.trim());
  if (!m) return null;
  return {
    organizationId: m[1].toLowerCase(),
    staffId: m[2].toLowerCase(),
    rawToken: m[3],
  };
}

export function hashStaffToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface RecognizedStaff {
  staff_id: string;
  staff_code: string;
  full_name: string;
}

export type RecognizeOutcome =
  | { kind: "recognized"; staff: RecognizedStaff; credentialId: string }
  | { kind: "invalid"; reason: string };

/**
 * Verify a staff QR against staff_qr_credentials + staff_profiles.
 *
 * Security contract:
 *   - organization_id trong QR phải match agent's organization_id.
 *   - Lookup BẰNG token_hash, không tin staff_id trong QR (staff_id chỉ là
 *     hint để tăng tốc lookup; token_hash mới là thứ chứng minh quyền).
 *   - staff_qr_credentials.status phải = 'active'.
 *   - staff_profiles.status phải = 'active'.
 *
 * Side effect khi recognized: touch staff_qr_credentials.last_used_at.
 */
export async function recognizeStaffQr(
  admin: SupabaseClient,
  agentOrgId: string,
  parsed: ParsedStaffQr,
): Promise<RecognizeOutcome> {
  if (parsed.organizationId !== agentOrgId) {
    return { kind: "invalid", reason: "org_mismatch" };
  }

  const tokenHash = hashStaffToken(parsed.rawToken);

  const { data: cred, error } = await admin
    .from("staff_qr_credentials")
    .select("id, staff_id, status, organization_id")
    .eq("organization_id", agentOrgId)
    .eq("staff_id", parsed.staffId)
    .eq("token_hash", tokenHash)
    .eq("status", "active")
    .maybeSingle();

  if (error) return { kind: "invalid", reason: "lookup_failed" };
  if (!cred) return { kind: "invalid", reason: "not_found_or_revoked" };

  const { data: staff } = await admin
    .from("staff_profiles")
    .select("id, staff_code, full_name, status, organization_id")
    .eq("id", cred.staff_id)
    .maybeSingle();

  if (!staff) return { kind: "invalid", reason: "staff_missing" };
  if (staff.organization_id !== agentOrgId) {
    return { kind: "invalid", reason: "staff_org_mismatch" };
  }
  if (staff.status !== "active") {
    return { kind: "invalid", reason: "staff_inactive" };
  }

  // Best-effort touch. Don't block on it; logging-only failure.
  const { error: touchErr } = await admin
    .from("staff_qr_credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", cred.id);
  if (touchErr) {
    console.warn(
      `[staff-qr] last_used_at touch failed cred=${cred.id} code=${touchErr.code ?? "?"} message=${touchErr.message}`,
    );
  }

  return {
    kind: "recognized",
    credentialId: cred.id,
    staff: {
      staff_id: staff.id,
      staff_code: staff.staff_code,
      full_name: staff.full_name,
    },
  };
}
