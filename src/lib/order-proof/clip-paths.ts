import "server-only";
import path from "node:path";
import { recordingDir } from "@/lib/camera/ffmpeg";
import { isInsideRecordingRoot } from "@/lib/camera/recording-paths";

// Layout: <RECORDING_DIR>/_clips/<waybill>/<packing_event_id>.mp4
//
// Why _clips/ (underscore prefix): the camera recording walker scans
// <RECORDING_DIR>/<camera_code>/Y/M/D — any path starting with an
// underscore can never collide with a camera_code (validation rejects
// underscores at position 0 only when generating, but we accept them
// here defensively). It also makes manual cleanup obvious.

function safeWaybill(code: string): string {
  return code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "_unknown";
}

export function clipsRoot(): string {
  return path.join(recordingDir(), "_clips");
}

export function clipDirFor(waybillCode: string): string {
  return path.join(clipsRoot(), safeWaybill(waybillCode));
}

export function clipFileFor(
  waybillCode: string,
  packingEventId: string,
): { dir: string; fileName: string; fullPath: string } {
  const dir = clipDirFor(waybillCode);
  const fileName = `${packingEventId}.mp4`;
  return { dir, fileName, fullPath: path.join(dir, fileName) };
}

// Same defense as recording stream: even though paths come from our own
// DB rows we double-check they stay under RECORDING_DIR.
export function clipPathIsSafe(absPath: string): boolean {
  return isInsideRecordingRoot(absPath);
}
