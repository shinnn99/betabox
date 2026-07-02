import "server-only";

/**
 * Config cho snapshot camera onboard (Lát 2 SaaS refactor):
 * agent capture JPEG → upload bucket `camera-snapshots-transient` →
 * cloud cấp signed URL cho UI.
 */
export const SNAPSHOT_BUCKET_NAME = "camera-snapshots-transient";

/** Signed URL cho JPEG snapshot — 15 phút đủ cho UI hiển thị + có thể lưu lại. */
export const SNAPSHOT_SIGNED_URL_TTL_SECONDS = Number(
  process.env.SNAPSHOT_SIGNED_URL_TTL_SECONDS ?? 900,
);

/**
 * Path trong bucket cho snapshot của một camera:
 *   <org_id>/<camera_id>-<timestamp>.jpg
 * Timestamp cuối để không đè snapshot cũ khi user chụp lại.
 */
export function snapshotBucketPathFor(
  orgId: string,
  cameraId: string,
): string {
  const ts = Date.now();
  return `${orgId}/${cameraId}-${ts}.jpg`;
}
