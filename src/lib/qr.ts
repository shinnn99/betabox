import "server-only";
import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { createAdminClient } from "@/lib/supabase/admin";

export interface QrIssue {
  rawToken: string;
  tokenHash: string;
  tokenPrefix: string;
  payload: string;
  pngDataUrl: string;
}

export async function issueStaffQr(
  organizationId: string,
  staffId: string
): Promise<QrIssue> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const tokenPrefix = rawToken.slice(0, 6);
  const payload = `${organizationId}.${staffId}.${rawToken}`;
  const pngDataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
  });
  return { rawToken, tokenHash, tokenPrefix, payload, pngDataUrl };
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Revoke active QR (nếu có) rồi cấp mới + insert vào staff_qr_credentials.
 * Trả về kèm pngDataUrl + payload để caller hiển thị / log.
 */
export async function issueAndStoreStaffQr(
  organizationId: string,
  staffId: string,
  issuedBy: string | null
): Promise<QrIssue> {
  const admin = createAdminClient();

  await admin
    .from("staff_qr_credentials")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("staff_id", staffId)
    .eq("status", "active");

  const issued = await issueStaffQr(organizationId, staffId);

  const { error } = await admin.from("staff_qr_credentials").insert({
    organization_id: organizationId,
    staff_id: staffId,
    token_hash: issued.tokenHash,
    token_prefix: issued.tokenPrefix,
    payload: issued.payload,
    status: "active",
    issued_by: issuedBy,
  });
  if (error) throw new Error(error.message);

  return issued;
}
