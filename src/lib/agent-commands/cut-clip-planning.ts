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
