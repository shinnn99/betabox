import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildProofClipFileName } from "@/lib/order-proof/clip-file-name";
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
      /** Cùng URL nhưng buộc trình duyệt tải xuống với tên file đẹp. */
      downloadUrl: string;
      /** `<mã vận đơn>-<ngày>-<giờ>.mp4`. */
      fileName: string;
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
 *
 * Safe-retry (2026-07-06): 1 pe có thể có 2 row cùng lúc — ready cũ +
 * pending mới đang regenerate. `.maybeSingle()` throw/return null khi
 * thấy 2 row → helper hỏng. Lấy row 'ready' ưu tiên; fallback 'pending'
 * hoặc row còn lại (không phải superseded) nếu chưa có ready.
 */
export async function createProofClipSignedUrlByPackingEvent(
  ctx: OrgCtx,
  packingEventId: string,
): Promise<ProofClipSignedUrlResult> {
  const admin = createAdminClient();
  const { data: clips } = await admin
    .from("order_proof_clips")
    .select("organization_id, status, bucket_path, bucket_uploaded_at, packing_event_id")
    .eq("packing_event_id", packingEventId)
    .neq("status", "superseded")
    .order("created_at", { ascending: false });
  const rows = clips ?? [];
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  // Ưu tiên row 'ready' (playable ngay); nếu chưa có, fallback row mới
  // nhất (có thể pending hoặc failed) → signIfBucketValid trả not_ready
  // đúng semantic.
  const clip = rows.find((r) => r.status === "ready") ?? rows[0];
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
    .select("organization_id, status, bucket_path, bucket_uploaded_at, packing_event_id")
    .eq("id", clipId)
    .neq("status", "superseded")
    .maybeSingle();
  if (!clip) return { ok: false, reason: "not_found" };
  if (clip.organization_id !== ctx.organizationId) {
    return { ok: false, reason: "cross_org" };
  }
  return signIfBucketValid(clip);
}

/**
 * Tên file tải xuống lấy từ `packing_events` chứ không từ
 * `order_proof_clips.waybill_code`: cột trên clip có row để rỗng (thấy
 * trong dữ liệu thật), còn packing_event luôn là nguồn đúng của mã đơn và
 * thời điểm quét.
 */
async function resolveDownloadFileName(packingEventId: string | null): Promise<string> {
  if (!packingEventId) return buildProofClipFileName({ waybillCode: null, scannedAt: null });
  const { data: event } = await createAdminClient()
    .from("packing_events")
    .select("waybill_code, scanned_at, event_kind")
    .eq("id", packingEventId)
    .maybeSingle();
  return buildProofClipFileName({
    waybillCode: event?.waybill_code ?? null,
    scannedAt: event?.scanned_at ?? null,
    eventKind: event?.event_kind ?? null,
  });
}

async function signIfBucketValid(clip: {
  status: string | null;
  bucket_path: string | null;
  bucket_uploaded_at: string | null;
  packing_event_id?: string | null;
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
  // Hai URL từ cùng một chữ ký: URL trần để `<video>` phát inline, URL kèm
  // `download` để nút tải xuống nhận Content-Disposition với tên file đẹp.
  // Không ký lần hai — chỉ thêm query param, đúng cách supabase-js làm khi
  // truyền option `download`.
  const fileName = await resolveDownloadFileName(clip.packing_event_id ?? null);
  const downloadUrl = `${signed.signedUrl}${signed.signedUrl.includes("?") ? "&" : "?"}download=${encodeURIComponent(fileName)}`;
  return {
    ok: true,
    signedUrl: signed.signedUrl,
    downloadUrl,
    fileName,
    expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  };
}
