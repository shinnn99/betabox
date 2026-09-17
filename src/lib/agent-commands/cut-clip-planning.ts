import "server-only";

interface QrCameraPlanArgs {
  snapshotCameraId: unknown;
  stationId: string | null;
}

export interface QrCameraPlan {
  cameraId: string | null;
  shouldResolveStationAssignment: boolean;
}

export function planQrCameraForProofClip(args: QrCameraPlanArgs): QrCameraPlan {
  if (typeof args.snapshotCameraId === "string" && args.snapshotCameraId) {
    return {
      cameraId: args.snapshotCameraId,
      shouldResolveStationAssignment: false,
    };
  }

  // `scan_source` controls which device is allowed to create a scan event.
  // Proof video is different: if a station has a QR camera assigned, the final
  // evidence clip should include that QR angle even when the order was created
  // by the handheld scanner flow.
  return {
    cameraId: null,
    shouldResolveStationAssignment: Boolean(args.stationId),
  };
}

/**
 * Góc QR có phải một camera KHÁC góc toàn cảnh không.
 *
 * Bàn chỉ gắn một camera (ví dụ chỉ có camera ở vị trí QR) thì cả hai góc
 * đều rơi vào cùng camera đó: `proof_camera_id` lấy camera duy nhất của bàn,
 * `proof_qr_camera_id` cũng là nó. Ghép PiP khi đó là đặt một hình vào góc
 * chính nó — vô nghĩa, lại phải mã hoá lại thay vì cắt thẳng. Gặp thật
 * 17/09/2026 ở BAN_04 (chỉ có EZVIZ).
 */
export function isSeparateQrAngle(
  overviewCameraId: string | null | undefined,
  qrCameraId: string | null | undefined,
): boolean {
  if (!qrCameraId) return false;
  return qrCameraId !== overviewCameraId;
}
