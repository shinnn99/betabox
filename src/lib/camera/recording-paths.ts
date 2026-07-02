import "server-only";
import path from "node:path";
import { recordingDir } from "./ffmpeg";

// Layout: <RECORDING_DIR>/<camera_code>/<YYYY>/<MM>/<DD>/<camera_code>_<YYYYMMDD>_<HHMMSS>.mp4
// ffmpeg `-strftime 1 -f segment` substitutes the date placeholders for
// us at segment-open time, so the pattern can use %Y/%m/%d directly.

const FILENAME_RE = /^([A-Za-z0-9_-]+)_(\d{8})_(\d{6})\.mp4$/;

function safeCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function cameraRecordingDir(cameraCode: string): string {
  return path.join(recordingDir(), safeCode(cameraCode));
}

// Output pattern fed to `ffmpeg -strftime 1 -f segment`. The directory
// structure (Y/M/D) is created lazily by ffmpeg.
export function segmentPattern(cameraCode: string): string {
  const code = safeCode(cameraCode);
  return path.join(
    cameraRecordingDir(code),
    "%Y",
    "%m",
    "%d",
    `${code}_%Y%m%d_%H%M%S.mp4`,
  );
}

// Parse the timestamp out of a segment filename. Returns null if the
// file doesn't look like one we produced — those are skipped during
// sync to avoid claiming foreign files.
export function parseSegmentFilename(
  fileName: string,
): { cameraCode: string; startedAt: Date } | null {
  const m = FILENAME_RE.exec(fileName);
  if (!m) return null;
  const [, code, ymd, hms] = m;
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const hour = Number(hms.slice(0, 2));
  const minute = Number(hms.slice(2, 4));
  const second = Number(hms.slice(4, 6));
  // Filenames are written in local time by ffmpeg's strftime, matching
  // the server's TZ. Construct as local then return.
  const d = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(d.getTime())) return null;
  return { cameraCode: code, startedAt: d };
}

// Defensive: ensure a path stays inside RECORDING_DIR. We use this on
// every stream/list operation to block path traversal even though the
// path normally comes from our own DB rows.
export function isInsideRecordingRoot(absPath: string): boolean {
  const root = recordingDir();
  const rel = path.relative(root, absPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
