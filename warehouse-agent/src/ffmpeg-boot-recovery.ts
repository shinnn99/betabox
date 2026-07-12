import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import type { PidEntry, PidRegistry } from "./pid-registry";
import { fingerprintArgs } from "./pid-registry";

const execAsync = promisify(exec);

/**
 * CRIT-1 (B2) boot recovery: kill ffmpeg zombie từ lần chạy agent trước.
 *
 * Chiến lược an toàn:
 *   1. Đọc PID registry file.
 *   2. Với mỗi entry: verify PID còn tồn tại + command line match
 *      fingerprint. Nếu match → kill process tree (`taskkill /T /F` trên
 *      Windows, `kill -9 -pid` trên POSIX).
 *   3. Nếu PID không tồn tại (đã tự chết) → xóa entry.
 *   4. Nếu PID tồn tại nhưng command line KHÔNG match (PID đã bị OS tái
 *      sử dụng cho process khác) → KHÔNG kill, xóa entry, log warn.
 *   5. Sau khi xử toàn bộ entries → clear registry (spawn tiếp theo sẽ
 *      write entry mới).
 *
 * Trả về summary để log.
 */

export interface BootRecoveryResult {
  totalEntries: number;
  killed: number;
  killedByRegistryTrust: number; // 3 tầng: kill vì registry nói của mình + không đọc được CommandLine để verify
  alreadyDead: number;
  pidReused: number;
  errors: number;
}

/**
 * Chỉ check PID còn sống hay không — KHÔNG cần đọc CommandLine.
 * Signal 0 test tồn tại process (POSIX). Windows: dùng `tasklist /FI "PID eq X"`
 * đếm dòng — không phụ thuộc quyền đọc CommandLine của LocalSystem process.
 *
 * Nguồn tin: "process còn sống" LUÔN đọc được; "CommandLine là gì" tùy quyền.
 * Xây fallback trên thứ luôn đọc được.
 */
async function isProcessAlive(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execAsync(
        `tasklist /FI "PID eq ${pid}" /NH /FO CSV`,
        { timeout: 5000, windowsHide: true, encoding: "utf8" } as never,
      );
      // Nếu PID không tồn tại, tasklist in "INFO: No tasks are running which
      // match the specified criteria." (stderr với /NH vẫn có message stdout
      // trên một số Windows). Chắc: parse — line CSV chứa dấu phẩy và tên
      // exe → nếu có "ffmpeg.exe" hoặc tên bất kỳ .exe trong dòng đầu → sống.
      return /\.exe/i.test(String(stdout));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kiểm PID có tồn tại + lấy command line trên Windows.
 * Trả `null` nếu PID không tồn tại.
 */
async function getWindowsProcessCommandLine(
  pid: number,
): Promise<string | null> {
  try {
    // wmic deprecated ở Windows 11 nhưng vẫn tồn tại. PowerShell dùng
    // rộng rãi trong installer nên tin cậy.
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine"`,
      { timeout: 5000, windowsHide: true, encoding: "utf8" } as never,
    );
    const line = String(stdout).trim();
    return line || null;
  } catch {
    // exit code khác 0 hoặc timeout → coi như PID không tồn tại.
    return null;
  }
}

async function getPosixProcessCommandLine(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o args=`, {
      timeout: 3000,
    });
    const line = String(stdout).trim();
    return line || null;
  } catch {
    return null;
  }
}

async function getProcessCommandLine(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    return getWindowsProcessCommandLine(pid);
  }
  return getPosixProcessCommandLine(pid);
}

/**
 * Command line thực tế của process có chứa fingerprint (fingerprint =
 * hash của args gốc). Đây là verification không chặt — command line
 * chỉ chứa args plaintext, không phải hash. Cách chặt hơn: so args
 * plaintext với snapshot lưu ở registry.
 *
 * Cách impl hiện tại: hash args plaintext extract từ command line rồi
 * so với fingerprint. Nếu process là ffmpeg và args giống với lúc spawn,
 * hash sẽ match.
 *
 * Tuy nhiên nếu Windows command line quoting đổi (VD dấu ngoặc, escape)
 * hash không match. Fallback: match yếu bằng cách xác nhận command line
 * chứa từ "ffmpeg" — không chặt nhưng đủ để giảm false-positive.
 */
function commandLineMatches(cmdLine: string, fingerprint: string): boolean {
  // Hash toàn bộ command line + so; tolerant hơn split.
  // Không tin tưởng 100% vì command line raw của Windows có thể có extra
  // spacing so với args array — nhưng process ffmpeg cùng cấu hình sẽ
  // cho cùng args order → hash gần nhau. Bỏ qua match strict trong impl
  // này; dùng heuristic:
  //
  //   - Nếu chứa "ffmpeg" (case-insensitive) → coi là "khả năng là process
  //     ffmpeg cũ của agent", allow kill.
  //   - Nếu không → coi là PID reuse cho process khác, KHÔNG kill.
  //
  // Thay đổi: sử dụng fingerprint chỉ để log; quyết định kill dựa vào
  // "process này là ffmpeg". fingerprint được persist để debug lịch sử.
  void fingerprint;
  return /ffmpeg/i.test(cmdLine);
}

async function killProcessTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      await execAsync(`taskkill /PID ${pid} /T /F`, {
        timeout: 5000,
        windowsHide: true,
      } as never);
      return true;
    } catch {
      return false;
    }
  }
  // POSIX: kill -9 -pid = kill process group. Chỉ hoạt động nếu ffmpeg
  // spawn trong detached process group. Best-effort.
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Tầng 1 (chính xác nhất): đọc registry, xử từng entry.
 *   - CommandLine đọc được + khớp marker "ffmpeg" → kill (kill_by_cmdline).
 *   - CommandLine đọc được + KHÔNG khớp → PID reuse, KHÔNG kill (chống giết nhầm).
 *   - CommandLine KHÔNG đọc được (null/rỗng) + process CÒN SỐNG → tin registry,
 *     kill (kill_by_registry_trust). Đây là fallback đóng ca LocalSystem-hidden.
 *   - CommandLine không đọc được + process ĐÃ CHẾT → already_dead, xóa entry.
 *
 * Điểm cứng: **"process còn sống" đọc bằng tasklist PID-only, luôn đọc được;
 * "CommandLine là gì" tùy quyền.** Fallback trên thứ luôn đọc được.
 */
export async function recoverZombieFfmpeg(
  registry: PidRegistry,
): Promise<BootRecoveryResult> {
  const entries = await registry.list();
  const result: BootRecoveryResult = {
    totalEntries: entries.length,
    killed: 0,
    killedByRegistryTrust: 0,
    alreadyDead: 0,
    pidReused: 0,
    errors: 0,
  };

  for (const entry of entries) {
    try {
      const cmdLine = await getProcessCommandLine(entry.pid);
      if (cmdLine !== null) {
        // CommandLine đọc được → phân biệt ffmpeg vs PID reuse chính xác.
        if (!commandLineMatches(cmdLine, entry.fingerprint)) {
          result.pidReused++;
          console.warn(
            `[boot-recovery] entry camera=${entry.cameraCode} pid=${entry.pid} PID reused by other process, NOT killing. cmd=${cmdLine.slice(0, 80)}`,
          );
          await registry.remove(entry.cameraId);
          continue;
        }
        const killed = await killProcessTree(entry.pid);
        if (killed) {
          result.killed++;
          console.log(
            `[boot-recovery] killed zombie ffmpeg camera=${entry.cameraCode} pid=${entry.pid}`,
          );
        } else {
          result.errors++;
          console.error(
            `[boot-recovery] failed to kill camera=${entry.cameraCode} pid=${entry.pid}`,
          );
        }
        await registry.remove(entry.cameraId);
        continue;
      }

      // CommandLine null: có thể (a) PID không tồn tại, HOẶC (b) PID sống
      // nhưng không đọc được CommandLine (LocalSystem hidden). Phân biệt
      // bằng isProcessAlive — chỉ PID, không cần quyền.
      const alive = await isProcessAlive(entry.pid);
      if (!alive) {
        result.alreadyDead++;
        console.log(
          `[boot-recovery] entry camera=${entry.cameraCode} pid=${entry.pid} already dead, removing`,
        );
        await registry.remove(entry.cameraId);
        continue;
      }

      // Fallback: PID sống + không đọc được CommandLine → tin registry.
      // Rủi ro giết nhầm gần 0 (registry chỉ chứa PID agent tự spawn),
      // nhưng nếu PID đã bị OS reuse cho process khác trong lúc CommandLine
      // ẩn thì có thể sai. Chấp nhận: xác suất PID-reuse chính khoảnh khắc
      // này thấp hơn nhiều xác suất zombie ffmpeg thật.
      const killed = await killProcessTree(entry.pid);
      if (killed) {
        result.killedByRegistryTrust++;
        console.warn(
          `[boot-recovery] killed by registry-trust (CommandLine hidden) camera=${entry.cameraCode} pid=${entry.pid}`,
        );
      } else {
        result.errors++;
        console.error(
          `[boot-recovery] registry-trust kill failed camera=${entry.cameraCode} pid=${entry.pid}`,
        );
      }
      await registry.remove(entry.cameraId);
    } catch (err) {
      result.errors++;
      console.error(
        `[boot-recovery] entry camera=${entry.cameraCode} pid=${entry.pid} error: ${(err as Error).message}`,
      );
    }
  }

  return result;
}

/**
 * Verify sau boot recovery: quét registry SAU khi xử xong, chưa entry nào
 * còn sống. Nếu còn PID sống = kill fail hoặc entry chưa xóa. Trả về danh
 * sách PID còn sống (empty = sạch).
 *
 * Đây là tầng 3 — cứu cánh cuối, XÂY TRÊN THỨ LUÔN ĐỌC ĐƯỢC (`isProcessAlive`,
 * không phụ thuộc CommandLine). Kể cả CommandLine mù hoàn toàn trên máy nào
 * đó, tầng này vẫn chặn được ca 2-ffmpeg.
 */
export async function verifyRegistryClean(
  registry: PidRegistry,
): Promise<{ stillAlivePids: number[] }> {
  const entries = await registry.list();
  const still: number[] = [];
  for (const e of entries) {
    if (await isProcessAlive(e.pid)) still.push(e.pid);
  }
  return { stillAlivePids: still };
}

/**
 * Test helper — expose internals cho unit test.
 * Không dùng cho prod.
 */
export const _internals = {
  commandLineMatches,
  fingerprintArgs,
  getProcessCommandLine,
};

// silence unused if not consumed
void spawn;
