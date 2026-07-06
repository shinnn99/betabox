import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET_NAME, BUCKET_TTL_HOURS, SIGNED_URL_TTL_SECONDS } from "./config";

/**
 * N2 DiD-A: helper DUY NHẤT được phép cấp signed URL cho proof clip.
 *
 * Bối cảnh multi-tenant chung một project + chung bucket `proof-clips-transient`:
 * mỗi khách nhìn thấy clip khách khác = phá sản phẩm bằng chứng. Gate 2 đóng
 * row-level (không thấy pe_id/clip_id của org khác qua PostgREST), nhưng storage
 * KHÔNG có RLS active — service_role bypass mọi thứ. Nghĩa là: route nào cầm
 * bucket_path và gọi `createSignedUrl` mà QUÊN verify org = lộ chéo.
 *
 * Chiến thuật: cấm mọi caller gọi `createSignedUrl` trực tiếp trên bucket này.
 * Chỉ helper dưới đây được phép — helper TỰ query DB verify org bên trong,
 * caller KHÔNG được truyền `bucketPath` trần. Grep-CI (scripts/ci/check-proof-
 * clip-signed-url.sh) exit-1 nếu bắt gặp `createSignedUrl` ngoài file này.
 *
 * Hai entry point ứng với hai cách gọi hiện có:
 *   - byPackingEvent(ctx, peId): route /watch reconcile.
 *   - byClipId(ctx, clipId): route legacy /clips/[clipId] (đã @deprecated).
 *
 * Không nhận `bucketPath` trần từ caller — helper tự derive từ row.
 */

type OrgCtx = { organizationId: string };

export type ProofClipSignedUrlResult =
  | {
      ok: true;
      signedUrl: string;
      expiresAt: string;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "cross_org"
        | "not_ready"
        | "bucket_missing"
        | "bucket_expired"
        | "signed_url_failed";
      message?: string;
    };

/**
 * Cấp signed URL cho clip của một packing_event.
 * Verify: clip tồn tại, thuộc org của ctx, ready, bucket_path còn TTL.
 */
export async function createProofClipSignedUrlByPackingEvent(
  ctx: OrgCtx,
  packingEventId: string,
): Promise<ProofClipSignedUrlResult> {
  const admin = createAdminClient();
  const { data: clip } = await admin
    .from("order_proof_clips")
    .select("organization_id, status, bucket_path, bucket_uploaded_at")
    .eq("packing_event_id", packingEventId)
    .neq("status", "superseded")
    .maybeSingle();
  if (!clip) return { ok: false, reason: "not_found" };
  if (clip.organization_id !== ctx.organizationId) {
    return { ok: false, reason: "cross_org" };
  }
  return signIfBucketValid(clip);
}

/**
 * Cấp signed URL cho clip theo clip_id (route legacy /clips/[clipId]).
 * Verify: clip tồn tại, thuộc org của ctx, ready, bucket_path còn TTL.
 */
export async function createProofClipSignedUrlByClipId(
  ctx: OrgCtx,
  clipId: string,
): Promise<ProofClipSignedUrlResult> {
  const admin = createAdminClient();
  const { data: clip } = await admin
    .from("order_proof_clips")
    .select("organization_id, status, bucket_path, bucket_uploaded_at")
    .eq("id", clipId)
    .neq("status", "superseded")
    .maybeSingle();
  if (!clip) return { ok: false, reason: "not_found" };
  if (clip.organization_id !== ctx.organizationId) {
    return { ok: false, reason: "cross_org" };
  }
  return signIfBucketValid(clip);
}

async function signIfBucketValid(clip: {
  status: string | null;
  bucket_path: string | null;
  bucket_uploaded_at: string | null;
}): Promise<ProofClipSignedUrlResult> {
  if (clip.status !== "ready") return { ok: false, reason: "not_ready" };
  if (!clip.bucket_path || !clip.bucket_uploaded_at) {
    return { ok: false, reason: "bucket_missing" };
  }
  const uploadedMs = new Date(clip.bucket_uploaded_at).getTime();
  const ageMs = Date.now() - uploadedMs;
  if (!Number.isFinite(uploadedMs) || ageMs >= BUCKET_TTL_HOURS * 3600 * 1000) {
    return { ok: false, reason: "bucket_expired" };
  }

  // eslint-disable-next-line n2-proof-clip/no-direct-createsignedurl
  const { data: signed, error: signedErr } = await createAdminClient()
    .storage.from(BUCKET_NAME)
    .createSignedUrl(clip.bucket_path, SIGNED_URL_TTL_SECONDS);
  if (signedErr || !signed) {
    return {
      ok: false,
      reason: "signed_url_failed",
      message: signedErr?.message ?? "unknown",
    };
  }
  return {
    ok: true,
    signedUrl: signed.signedUrl,
    expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  };
}
