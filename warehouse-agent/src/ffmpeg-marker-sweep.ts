import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

/**
 * Lưới an toàn boot: sau B2 CRIT-1 (`recoverZombieFfmpeg` đọc pid-registry),
 * quét process list lọc ffmpeg CÓ marker (output path chứa `recordingRoot`
 * substring) mà KHÔNG trong registry — kill nốt. Đóng ca `pid-registry.json`
 * mất/hỏng/chưa kịp ghi khi crash cứng.
 *
 * Nguyên tắc: **registry file ≠ process thật trên máy**. Registry là file
 * agent tự ghi, có thể mất. Process list là nguồn thật.
 *
 * Marker: substring `recordingRoot` trong CommandLine (VD `beta_cam_recordings`).
 * Grep pattern đặc trưng — ffmpeg của user (không output vào recordingRoot
 * của agent) KHÔNG bị nhận diện, KHÔNG bị kill. Verify Admin CommandLine đọc
 * được (2026-07-12): agent LocalSystem quyền cao hơn, chắc chắn đọc được.
 *
 * Windows-only. POSIX no-op (agent chạy Windows Service).
 */

export interface FfmpegScanResult {
  totalFfmpeg: number;
  markerMatches: Array<{ pid: number; cmdLine: string }>;
  killed: number;
  killFailed: number;
  errors: number;
}

async function listFfmpegWithCmdLine(): Promise<
  Array<{ pid: number; cmdLine: string }>
> {
  if (process.platform !== "win32") return [];

  // PowerShell -EncodedCommand: UTF-16LE base64. Tránh mọi shell escape
  // (backslash, dollar sign, quote — cmd.exe + PowerShell interact rối).
  const script = `Get-CimInstance Win32_Process -Filter "name='ffmpeg.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -EncodedCommand ${encoded}`,
      { timeout: 10_000, windowsHide: true, encoding: "utf8" } as never,
    );
    const lines = String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const out: Array<{ pid: number; cmdLine: string }> = [];
    for (const line of lines) {
      const sep = line.indexOf("|");
      if (sep < 0) continue;
      const pidStr = line.slice(0, sep);
      const cmd = line.slice(sep + 1);
      const pid = Number(pidStr);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      out.push({ pid, cmdLine: cmd });
    }
    return out;
  } catch {
    return [];
  }
}

async function killWindows(pid: number): Promise<boolean> {
  try {
    await execAsync(`taskkill /PID ${pid} /T /F`, {
      timeout: 5_000,
      windowsHide: true,
    } as never);
    return true;
  } catch {
    return false;
  }
}

/**
 * Quét ffmpeg có marker `recordingRoot` trong CommandLine, loại trừ PID
 * biết đến (registry hoặc process của session mới sẽ spawn). Kill nốt.
 *
 * `excludePids`: PID không kill (VD PID trong registry đã xử lý riêng
 * bởi `recoverZombieFfmpeg`, hoặc PID đang test).
 */
export async function sweepMarkerOrphans(params: {
  recordingRoot: string;
  excludePids?: Set<number>;
}): Promise<FfmpegScanResult> {
  const exclude = params.excludePids ?? new Set<number>();
  const result: FfmpegScanResult = {
    totalFfmpeg: 0,
    markerMatches: [],
    killed: 0,
    killFailed: 0,
    errors: 0,
  };

  const procs = await listFfmpegWithCmdLine();
  result.totalFfmpeg = procs.length;

  // Marker: recordingRoot substring có mặt trong CommandLine. Path Windows
  // backslash — CommandLine giữ backslash. Case-insensitive để bền với
  // path case.
  const markerNeedle = params.recordingRoot.toLowerCase();

  for (const p of procs) {
    if (exclude.has(p.pid)) continue;
    if (!p.cmdLine.toLowerCase().includes(markerNeedle)) continue;
    result.markerMatches.push(p);
  }

  for (const m of result.markerMatches) {
    const ok = await killWindows(m.pid);
    if (ok) result.killed++;
    else result.killFailed++;
  }

  return result;
}

/**
 * Sau khi kill (registry + lưới marker), quét lại verify sạch thật.
 * Trả về danh sách ffmpeg có marker VẪN CÒN — nếu > 0, kill fail, agent
 * KHÔNG được declare `alive=[]`.
 *
 * Đây là biến thể "verify sau khi hành động" — không tin "tôi đã kill",
 * phải kiểm process list sau kill.
 */
export async function verifyMarkerSweptClean(params: {
  recordingRoot: string;
  excludePids?: Set<number>;
}): Promise<{ remaining: Array<{ pid: number; cmdLine: string }> }> {
  const exclude = params.excludePids ?? new Set<number>();
  const procs = await listFfmpegWithCmdLine();
  const needle = params.recordingRoot.toLowerCase();
  const remaining = procs.filter(
    (p) => !exclude.has(p.pid) && p.cmdLine.toLowerCase().includes(needle),
  );
  return { remaining };
}
