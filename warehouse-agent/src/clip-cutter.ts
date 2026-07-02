import { spawn } from "node:child_process";
import { mkdir, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * BLOCKS-GO-LIVE (rủi ro pháp lý, không chỉ kỹ thuật):
 *
 * Với partial coverage, concat demuxer + -c copy NỐI THẲNG hai đoạn
 * video qua gap — không màn đen, không dấu hiệu trên khung hình.
 * Với gap nhỏ (VD 4s respawn từ Lát 2), mắt không nhận ra và vô hại.
 * Với gap LỚN (VD 14 phút cam offline), clip trông liền mạch nhưng
 * đã bỏ mất 14 phút:
 *   - Đối phương ở sàn/tranh chấp chỉ cần chỉ ra timestamp nhảy để
 *     nghi ngờ cắt ghép giấu diếm.
 *   - UI metadata (is_partial=true, covered_range) KHÔNG đi theo file
 *     khi tải xuống gửi đối tác — chỉ file .mp4 đi.
 *   - Clip có thể phản lại chính người kho, ngược ý nghĩa bằng chứng.
 *
 * 3a-2 CHƯA giải cái này — chỉ báo covered_range + gaps đủ để cloud
 * biết độ lớn gap. Trước khi cho phép clip partial gap-lớn GIAO cho
 * sàn, phải chốt cách xử — ba lựa chọn có thể:
 *   (A) Chèn màn đen + text "GAP N MINUTES" tại điểm nối (cần
 *       re-encode, sẽ dính 3b).
 *   (B) Từ chối cắt clip khi gap vượt ngưỡng, báo lỗi có chủ đích
 *       ("cam offline khoảng này, không tạo được clip đủ tin cậy").
 *   (C) Timestamp burn-in (3b) sẽ nhảy khi có gap — người xem tinh
 *       ý nhận ra, nhưng KHÔNG đủ mạnh cho tranh chấp pháp lý.
 *
 * Đây là quyết định SẢN PHẨM, không phải kỹ thuật. Chưa được quyết
 * ở 3a-2. Trước go-live: quyết cách xử + implement.
 */

export interface CutSegmentInput {
  file_path: string; // relative to recordingRoot
  started_at: string; // ISO UTC
  ended_at: string | null;
  duration_seconds: number | null;
}

export type BurnPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export interface BurnInParams {
  fontPath: string; // absolute path to ttf/otf font
  waybillCode: string;
  workStartedAt: string; // ISO UTC — mốc quét đơn thô
  workEndedAt: string | null; // ISO UTC — null nếu đơn chưa đóng
  isPartial: boolean;
  totalGapSeconds: number;
  position: BurnPosition;
  fontSizeRatio: number;
  fontColor: string;
  borderColor: string;
  borderWidth: number;
  warningColor: string;
}

export interface CutClipParams {
  ffmpegBin: string;
  ffprobeBin: string;
  recordingRoot: string;
  outputAbsPath: string; // <recordingRoot>/_clips/<packing_event_id>.mp4
  cutStart: Date;
  cutEnd: Date;
  segments: CutSegmentInput[]; // sorted by started_at
  timeoutMs?: number;
  /**
   * 3b-1: nếu có, ffmpeg sẽ re-encode và burn-in mã vận đơn +
   * timestamp lên khung hình. Nếu null → dùng -c copy như 3a-2.
   */
  burnIn?: BurnInParams | null;
}

export interface CutClipResult {
  ok: boolean;
  errorMessage?: string;
  fileSizeBytes: number;
  durationSeconds: number;
  durationDriftSeconds: number;
  stderrTail: string;
  elapsedMs: number;
}

function buildConcatList(segments: CutSegmentInput[], recordingRoot: string): string {
  return (
    segments
      .map((s) => {
        const abs = path.join(recordingRoot, s.file_path);
        // Escape single quote for ffmpeg concat file format.
        const escaped = abs.replaceAll("'", "'\\''");
        return `file '${escaped}'`;
      })
      .join("\n") + "\n"
  );
}

export async function cutClip(params: CutClipParams): Promise<CutClipResult> {
  const started = Date.now();
  const outDir = path.dirname(params.outputAbsPath);
  await mkdir(outDir, { recursive: true });

  const listPath = `${params.outputAbsPath}.concat.txt`;
  await writeFile(listPath, buildConcatList(params.segments, params.recordingRoot), "utf8");

  // Offset trong concat stream ảo, tính từ started_at của segment
  // đầu tiên. `Date.parse`/`getTime()` hoạt động trên UTC millis —
  // TZ máy không ảnh hưởng.
  const firstStart = Date.parse(params.segments[0].started_at);
  const ssSeconds = Math.max(0, (params.cutStart.getTime() - firstStart) / 1000);
  const tSeconds = Math.max(
    0,
    (params.cutEnd.getTime() - params.cutStart.getTime()) / 1000,
  );

  // `-ss` đặt SAU `-i` (không phải trước). Đây là ca đặc biệt của
  // concat demuxer:
  //
  // Với input file đơn có index (mp4/mkv), `-ss` trước `-i` là INPUT
  // SEEK — nhảy tới keyframe gần mốc, nhanh. Cả input seek và output
  // seek đều snap keyframe với `-c copy`, không có "accurate seek".
  //
  // NHƯNG concat demuxer KHÔNG hỗ trợ input seek. Concat tạo virtual
  // stream nối các file — không có index toàn cục để tra. Đặt `-ss`
  // trước `-i` với `-f concat` → ffmpeg BỎ QUA seek, cắt ra clip
  // không đúng khoảng (verified: clip 74s thay vì 29s target khi
  // dùng `-ss` trước với concat).
  //
  // Kết luận cho 3a-2: dùng `-ss` sau `-i` cho concat. Nhược điểm:
  // ffmpeg phải parse timestamps của mọi packet trước mốc (không
  // decode video, chỉ đọc container) — chậm hơn input seek nhưng
  // vẫn nhanh vì packet parsing rất rẻ. Với 2-3 segment mp4 ≤ 60s
  // mỗi cái, tốn ~100-300ms, không cướp CPU đáng kể của recording.
  const args: string[] = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-ss", ssSeconds.toFixed(3),
    "-t", tSeconds.toFixed(3),
  ];

  if (params.burnIn) {
    // 3b-1 reencode + burn-in. Font, drawtext filter, x264 encode.
    // Fail-loud nếu font missing (BLOCK-GO-LIVE: bằng chứng không được
    // silent-fallback khác format).
    if (!existsSync(params.burnIn.fontPath)) {
      await unlink(listPath).catch(() => undefined);
      return {
        ok: false,
        errorMessage: `font_missing: ${params.burnIn.fontPath}`,
        fileSizeBytes: 0,
        durationSeconds: 0,
        durationDriftSeconds: 0,
        stderrTail: "",
        elapsedMs: Date.now() - started,
      };
    }
    const filter = buildBurnInFilter(params.burnIn);
    args.push(
      "-vf", filter,
      "-c:v", "libx264",
      "-preset", "veryfast",  // 3b-2 sẽ tinh chỉnh preset theo đo tải
      "-crf", "23",
      "-pix_fmt", "yuv420p",  // browser-safe
      "-movflags", "+faststart",
      "-an",  // clip bằng chứng không cần audio; nếu Lát sau cần, đổi ở đây
    );
  } else {
    args.push(
      "-c", "copy",
      "-bsf:v", "dump_extra",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "+faststart",
    );
  }

  args.push(params.outputAbsPath);

  // Reencode có thể chậm hơn copy nhiều lần — nới timeout khi burnIn on.
  // 3b-2 sẽ đo thực tế và tinh chỉnh; 300s là mức an toàn cho clip 60s.
  const timeoutMs = params.timeoutMs ?? (params.burnIn ? 300_000 : 60_000);

  let stderrTail = "";
  try {
    stderrTail = await new Promise<string>((resolve, reject) => {
      let proc;
      try {
        proc = spawn(params.ffmpegBin, args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        return reject(err);
      }
      let buf = "";
      const cap = 8_000;
      proc.stdout?.on("data", () => {});
      proc.stderr?.on("data", (chunk: Buffer) => {
        buf = (buf + chunk.toString("utf8")).slice(-cap);
      });
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
      }, timeoutMs);
      proc.on("close", () => {
        clearTimeout(t);
        resolve(buf.trim());
      });
      proc.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
  } catch (err) {
    // Dọn concat list ngay khi lỗi spawn — không đợi caller.
    await unlink(listPath).catch(() => undefined);
    return {
      ok: false,
      errorMessage: `spawn failed: ${(err as Error).message}`,
      fileSizeBytes: 0,
      durationSeconds: 0,
      durationDriftSeconds: 0,
      stderrTail: "",
      elapsedMs: Date.now() - started,
    };
  }

  // Dọn concat list — thành công hay thất bại đều dọn (finally-style).
  await unlink(listPath).catch(() => undefined);

  let size = 0;
  try {
    const st = await stat(params.outputAbsPath);
    size = st.size;
  } catch {
    // file not created — failure
  }

  const elapsedMs = Date.now() - started;

  if (size <= 0) {
    return {
      ok: false,
      errorMessage:
        "Không tạo được file clip. " +
        (stderrTail ? "Chi tiết: " + stderrTail.split("\n").slice(-3).join(" | ") : ""),
      fileSizeBytes: 0,
      durationSeconds: 0,
      durationDriftSeconds: 0,
      stderrTail,
      elapsedMs,
    };
  }

  const probed = await probeDurationSeconds(params.ffprobeBin, params.outputAbsPath);
  const durationSeconds = probed ?? tSeconds;
  const durationDriftSeconds = probed === null ? 0 : Math.abs(tSeconds - probed);

  return {
    ok: true,
    fileSizeBytes: size,
    durationSeconds,
    durationDriftSeconds,
    stderrTail,
    elapsedMs,
  };
}

async function probeDurationSeconds(bin: string, filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        bin,
        [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          filePath,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      return resolve(null);
    }
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    proc.stderr?.on("data", () => {});
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 10_000);
    proc.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return resolve(null);
      const n = Number(out.trim());
      if (!Number.isFinite(n) || n < 0) return resolve(null);
      resolve(n);
    });
  });
}

export async function checkSegmentsExist(params: {
  recordingRoot: string;
  segments: CutSegmentInput[];
}): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  for (const s of params.segments) {
    const abs = path.join(params.recordingRoot, s.file_path);
    if (!existsSync(abs)) missing.push(s.file_path);
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

/**
 * Format ISO UTC → giờ VN (dd/MM/yyyy, HH:mm:ss). KHÔNG dùng
 * `Intl.DateTimeFormat` vì phụ thuộc ICU data — sẽ vỡ khi đóng exe
 * ở Lát 6 nếu build strip ICU. Tự cộng +7h và đọc bằng `getUTC*` để
 * vô hiệu hóa TZ máy (mẹo: dịch millis lên 7h rồi đọc "UTC" → chính
 * là giờ VN, deterministic mọi máy).
 *
 * FIXED +07 VN NO DST — VN bỏ DST 1976, an toàn vĩnh viễn. Nếu deploy
 * cho TZ có DST, phải dùng luxon/date-fns-tz.
 */
export function formatVnDateTime(iso: string): { date: string; time: string } {
  const utcMs = Date.parse(iso);
  const vnMs = utcMs + 7 * 3600 * 1000;
  const d = new Date(vnMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}

/**
 * Escape font path cho drawtext filter trên Windows. Ffmpeg filter
 * syntax dùng ':' làm separator và '\' làm escape → path Windows sẽ
 * hỏng. Convert sang forward slash và escape ký tự đặc biệt cho
 * filter string.
 */
function escapeFontPathForFilter(p: string): string {
  // Forward slash — ffmpeg drawtext chấp nhận cả hai trên Windows,
  // nhưng '/' không cần escape.
  return p.replaceAll("\\", "/").replaceAll(":", "\\:");
}

/**
 * Escape text cho drawtext filter. Ký tự đặc biệt: `:`, `\`, `'`,
 * `%`. `%` dùng cho strftime expansion — nếu không escape, ffmpeg
 * cố parse `%X` thành placeholder → hỏng chữ hoặc crash. Ta không
 * dùng strftime (đã tự format tay VN), nên escape hết `%`.
 */
function escapeDrawtext(s: string): string {
  return s
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll("%", "\\%");
}

/**
 * Build filter drawtext cho burn-in. Ba dòng: waybill (cỡ lớn),
 * mốc thời gian (cỡ vừa), warning partial (cỡ nhỏ hơn, đỏ, chỉ khi
 * is_partial).
 */
function buildBurnInFilter(b: BurnInParams): string {
  const started = formatVnDateTime(b.workStartedAt);
  const endedText = b.workEndedAt
    ? formatVnDateTime(b.workEndedAt).time
    : "(đang xử lý)";

  // NotoSans-Bold KHÔNG có glyph cho `→` (U+2192) hoặc `⚠` (U+26A0)
  // — render ra ô vuông tofu. Verified bằng ffmpeg render + so size
  // PNG output. Dùng ASCII thay thế:
  //   `→` → `->`  (rõ nghĩa, không mất thẩm mỹ đáng kể)
  //   `⚠` → `[!]` (viết hoa toàn dòng warning đã nổi bật)
  //
  // Nếu tương lai muốn ký tự Unicode đẹp hơn, đổi font sang một
  // font có coverage rộng hơn (VD Noto Sans + Noto Sans Symbols
  // fallback) — nhưng ffmpeg drawtext không hỗ trợ font fallback,
  // phải merge thành một file .ttf duy nhất.
  const line1 = b.waybillCode;
  const line2 = `${started.date} ${started.time} -> ${endedText}`;
  const line3 = b.isPartial
    ? `[!] VIDEO CÓ KHOẢNG TRỐNG (${Math.round(b.totalGapSeconds / 60)} PHÚT)`
    : null;

  const fontPathEsc = escapeFontPathForFilter(b.fontPath);
  const size1 = `h*${(b.fontSizeRatio * 1.3).toFixed(3)}`;
  const size2 = `h*${b.fontSizeRatio.toFixed(3)}`;
  const size3 = `h*${(b.fontSizeRatio * 0.85).toFixed(3)}`;

  // Tính vị trí. drawtext hỗ trợ expression trong x,y — dùng biến
  // `text_w`, `text_h`, `w` (video width), `h` (video height), `line_h`.
  // Padding 20px từ mép.
  const margin = 20;
  const isRight = b.position.endsWith("right");
  const isTop = b.position.startsWith("top");
  const xExpr = isRight ? `w-text_w-${margin}` : `${margin}`;

  // Tính y cho 3 dòng chồng lên nhau. line 1 ở đầu, line 2 dưới line 1,
  // line 3 dưới line 2. Dùng khoảng cách bằng cỡ font từng dòng.
  // Với top: line1 ở y=margin, line2 = line1 + h1*1.4, line3 = line2 + h2*1.4.
  // Với bottom: đảo ngược — line cuối cùng gần đáy.
  let y1: string, y2: string, y3: string;
  if (isTop) {
    y1 = `${margin}`;
    y2 = `${margin}+${size1}*1.4`;
    y3 = `${margin}+${size1}*1.4+${size2}*1.4`;
  } else {
    // Bottom: line3 (nếu có) ở dưới cùng, line 1 ở trên.
    // Nếu không partial: chỉ 2 dòng, tính đơn giản hơn.
    const totalBlockNoWarn = `${size1}*1.4+${size2}*1.2`;
    const totalBlockWithWarn = `${size1}*1.4+${size2}*1.4+${size3}*1.2`;
    const bottomOffset = line3 ? totalBlockWithWarn : totalBlockNoWarn;
    y1 = `h-${margin}-(${bottomOffset})`;
    y2 = `h-${margin}-(${line3 ? `${size2}*1.4+${size3}*1.2` : `${size3 ? size3 : `${size2}*1.2`}`})`;
    y3 = `h-${margin}-${size3}*1.2`;
  }

  const commonOpts = (fontSize: string, y: string, color: string, text: string) =>
    [
      `fontfile='${fontPathEsc}'`,
      `text='${escapeDrawtext(text)}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${color}`,
      `borderw=${b.borderWidth}`,
      `bordercolor=${b.borderColor}`,
      `x=${xExpr}`,
      `y=${y}`,
    ].join(":");

  const filters: string[] = [
    `drawtext=${commonOpts(size1, y1, b.fontColor, line1)}`,
    `drawtext=${commonOpts(size2, y2, b.fontColor, line2)}`,
  ];
  if (line3) {
    filters.push(`drawtext=${commonOpts(size3, y3, b.warningColor, line3)}`);
  }

  return filters.join(",");
}

/**
 * Dọn `.concat.txt` orphan lúc boot — nếu agent crash giữa cắt clip,
 * file .concat.txt có thể còn sót trong _clips. Rẻ, gọi từ boot.
 */
export async function cleanupOrphanConcatFiles(clipsDir: string): Promise<number> {
  const fs = await import("node:fs/promises");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(clipsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".concat.txt")) {
      await fs.unlink(path.join(clipsDir, e.name)).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}
