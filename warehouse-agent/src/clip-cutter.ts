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

/**
 * Chống nghi cắt ghép — dấu chèn tại gap giữa hai segment.
 *
 * Cloud (enqueue.ts) quyết dựa 3 config env:
 *   MIN_GAP_TO_MARK_SECONDS (30s)      → gap ≥30s có dấu.
 *   MIN_GAP_TO_BLACK_FULL_SECONDS (60) → gap ≥60s: kind="black_full".
 *                                        gap 30-60s: kind="mark_short".
 *   MARK_DURATION_SECONDS (2)          → độ dài mark_short.
 *
 * black_full: duration_seconds = ĐÚNG gap_seconds (phản ánh độ dài).
 * mark_short: duration_seconds = 2s (đủ đọc "GAP 45 GIÂY", không phá nhịp).
 *
 * after_segment_index: chèn SAU segment index này trong concat. Agent
 * đan xen [seg0, mark_after_0?, seg1, mark_after_1?, seg2, ...].
 */
export interface GapMark {
  after_segment_index: number;
  gap_seconds: number;
  kind: "mark_short" | "black_full";
  duration_seconds: number;
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
  /**
   * Chống nghi cắt ghép: dấu chèn tại điểm nối gap. Nếu absent hoặc
   * rỗng → cắt như cũ (không dấu, tương thích payload agent version cũ).
   */
  marks?: GapMark[];
  /**
   * Resolution + fontPath cho render mark. Chỉ cần khi marks không rỗng.
   * Font path tương tự BurnInParams.fontPath — bắt buộc có nếu marks có.
   * Resolution: probe từ segment đầu (agent tự probe trước gọi cutClip),
   * hoặc mặc định 1920x1080 nếu probe fail. Camera EZVIZ H1c mặc định
   * 1920x1080 → an toàn.
   */
  markRenderConfig?: {
    fontPath: string;
    resolution: string; // "1920x1080"
    fontColor: string;
    warningColor: string;
  };
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

/**
 * Format gap_seconds thành label người đọc.
 *   45      → "45 GIÂY"
 *   75      → "1 PHÚT 15 GIÂY"
 *   120     → "2 PHÚT"
 *   3661    → "1 GIỜ 1 PHÚT" (hiếm nhưng có, cam offline lâu)
 */
function formatGapLabel(gapSeconds: number): string {
  if (gapSeconds < 60) return `${gapSeconds} GIÂY`;
  const totalMinutes = Math.floor(gapSeconds / 60);
  const remainSec = gapSeconds % 60;
  if (totalMinutes < 60) {
    return remainSec > 0
      ? `${totalMinutes} PHÚT ${remainSec} GIÂY`
      : `${totalMinutes} PHÚT`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remainMin = totalMinutes % 60;
  return remainMin > 0 ? `${hours} GIỜ ${remainMin} PHÚT` : `${hours} GIỜ`;
}

/**
 * Build drawtext filter cho video gap-mark. 3 dòng chồng ở giữa khung:
 *   Dòng 1 (nhỏ):   "[!] KHOẢNG TRỐNG"
 *   Dòng 2 (lớn):   "<N> GIÂY" hoặc "<N> PHÚT <M> GIÂY"
 *   Dòng 3 (nhỏ):   "Camera mất kết nối tại đây"
 *
 * Nền đen tuyệt đối (video source `color=black`) + text màu cảnh báo.
 * Font size scale theo height video (fontSizeRatio).
 */
function buildGapMarkFilter(
  label: string,
  fontPath: string,
  warningColor: string,
  fontColor: string,
): string {
  const fontPathEsc = fontPath.replaceAll("\\", "/").replaceAll(":", "\\:");
  const size1 = "h*0.045"; // dòng 1 nhỏ
  const size2 = "h*0.11";  // dòng 2 lớn (số/label chính)
  const size3 = "h*0.035"; // dòng 3 nhỏ hơn
  // Vị trí y: 3 dòng chồng nhau, group centered vertically.
  // Tổng chiều cao ≈ size1*1.4 + size2*1.4 + size3 ≈ h*0.24.
  // y_start = (h - group_h) / 2 = h*0.38.
  const y1 = "h*0.38";
  const y2 = `h*0.38 + ${size1}*1.4`;
  const y3 = `h*0.38 + ${size1}*1.4 + ${size2}*1.4`;

  const line1 = "[!] KHOẢNG TRỐNG";
  const line2 = label;
  const line3 = "Camera mất kết nối tại đây";

  const drawtext = (text: string, size: string, y: string, color: string) => {
    const escaped = text
      .replaceAll("\\", "\\\\")
      .replaceAll(":", "\\:")
      .replaceAll("'", "\\'")
      .replaceAll("%", "\\%");
    return [
      `fontfile='${fontPathEsc}'`,
      `text='${escaped}'`,
      `fontsize=${size}`,
      `fontcolor=${color}`,
      `borderw=3`,
      `bordercolor=black`,
      `x=(w-text_w)/2`,
      `y=${y}`,
    ].join(":");
  };

  return [
    `drawtext=${drawtext(line1, size1, y1, warningColor)}`,
    `drawtext=${drawtext(line2, size2, y2, warningColor)}`,
    `drawtext=${drawtext(line3, size3, y3, fontColor)}`,
  ].join(",");
}

/**
 * Sinh 1 video mp4 gap-mark tại `outPath`. Nền đen + drawtext.
 * Chọn cùng codec/pix_fmt/timescale với source clip để concat -c copy
 * không phải reencode ở step gộp:
 *   -c:v libx264 -pix_fmt yuv420p -video_track_timescale 90000
 *
 * Duration: đúng `durationSeconds` (frame gen theo `-t`, không cần
 * decode video source).
 */
async function renderGapMark(params: {
  ffmpegBin: string;
  outPath: string;
  durationSeconds: number;
  label: string;
  resolution: string;
  fontPath: string;
  fontColor: string;
  warningColor: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const filter = buildGapMarkFilter(
    params.label,
    params.fontPath,
    params.warningColor,
    params.fontColor,
  );
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", `color=black:s=${params.resolution}:d=${params.durationSeconds}:r=25`,
    "-vf", filter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-video_track_timescale", "90000",
    "-t", String(params.durationSeconds),
    "-an",
    "-movflags", "+faststart",
    params.outPath,
  ];

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(params.ffmpegBin, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return resolve({ ok: false, errorMessage: (err as Error).message });
    }
    let errBuf = "";
    proc.stdout?.on("data", () => {});
    proc.stderr?.on("data", (c: Buffer) => {
      errBuf = (errBuf + c.toString("utf8")).slice(-4000);
    });
    const t = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, params.timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(t);
      resolve({ ok: false, errorMessage: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) {
        return resolve({
          ok: false,
          errorMessage: `ffmpeg exit ${code}: ${errBuf.trim().slice(-300)}`,
        });
      }
      resolve({ ok: true });
    });
  });
}

/**
 * Xây concat list ĐAN XEN segments + marks. Mark chèn SAU segment
 * `after_segment_index`. Chấp nhận nhiều mark sau cùng segment (theo
 * thứ tự after_segment_index tăng dần).
 *
 * Ví dụ: segments=[s0,s1,s2], marks=[after 0, after 1] →
 *   file s0
 *   file mark_0.mp4
 *   file s1
 *   file mark_1.mp4
 *   file s2
 */
function buildInterleavedConcatList(
  segments: CutSegmentInput[],
  segmentAbsPaths: string[], // đã resolve từ recordingRoot
  markPaths: Map<number, string>, // after_segment_index → abs path
): string {
  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const abs = segmentAbsPaths[i];
    const escapedSeg = abs.replaceAll("'", "'\\''");
    lines.push(`file '${escapedSeg}'`);
    const markPath = markPaths.get(i);
    if (markPath) {
      const escapedMark = markPath.replaceAll("'", "'\\''");
      lines.push(`file '${escapedMark}'`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function cutClip(params: CutClipParams): Promise<CutClipResult> {
  const started = Date.now();
  const outDir = path.dirname(params.outputAbsPath);
  await mkdir(outDir, { recursive: true });

  // ------------------------------------------------------------------
  // Render gap marks TRƯỚC concat (nếu có).
  //
  // Chống nghi cắt ghép: chèn mark_short 2s tại gap 30-60s (định vị) +
  // màn đen full tại gap ≥60s (phản ánh độ dài). Cloud đã tính marks
  // trong payload → agent chỉ render + đan xen concat.
  //
  // Nếu marks rỗng hoặc absent → cắt như cũ (tương thích payload cũ).
  // ------------------------------------------------------------------
  const marks = params.marks ?? [];
  const markPaths = new Map<number, string>(); // after_segment_index → abs path
  const renderedMarkFiles: string[] = []; // để cleanup cuối
  let totalMarkDurationSeconds = 0;

  if (marks.length > 0) {
    if (!params.markRenderConfig) {
      return {
        ok: false,
        errorMessage:
          "marks_present_but_no_render_config: cloud gửi marks nhưng agent thiếu markRenderConfig (fontPath/resolution)",
        fileSizeBytes: 0,
        durationSeconds: 0,
        durationDriftSeconds: 0,
        stderrTail: "",
        elapsedMs: Date.now() - started,
      };
    }
    if (!existsSync(params.markRenderConfig.fontPath)) {
      return {
        ok: false,
        errorMessage: `mark_font_missing: ${params.markRenderConfig.fontPath}`,
        fileSizeBytes: 0,
        durationSeconds: 0,
        durationDriftSeconds: 0,
        stderrTail: "",
        elapsedMs: Date.now() - started,
      };
    }

    for (const mark of marks) {
      const markPath = `${params.outputAbsPath}.mark_${mark.after_segment_index}.mp4`;
      const label = formatGapLabel(mark.gap_seconds);
      const result = await renderGapMark({
        ffmpegBin: params.ffmpegBin,
        outPath: markPath,
        durationSeconds: mark.duration_seconds,
        label,
        resolution: params.markRenderConfig.resolution,
        fontPath: params.markRenderConfig.fontPath,
        fontColor: params.markRenderConfig.fontColor,
        warningColor: params.markRenderConfig.warningColor,
        timeoutMs: Math.max(30_000, mark.duration_seconds * 5000),
      });
      if (!result.ok) {
        // Cleanup marks đã render
        for (const f of renderedMarkFiles) await unlink(f).catch(() => undefined);
        return {
          ok: false,
          errorMessage: `render_mark_failed (after_seg=${mark.after_segment_index}, gap=${mark.gap_seconds}s): ${result.errorMessage}`,
          fileSizeBytes: 0,
          durationSeconds: 0,
          durationDriftSeconds: 0,
          stderrTail: "",
          elapsedMs: Date.now() - started,
        };
      }
      markPaths.set(mark.after_segment_index, markPath);
      renderedMarkFiles.push(markPath);
      totalMarkDurationSeconds += mark.duration_seconds;
    }
  }

  // ------------------------------------------------------------------
  // Build concat list — đan xen nếu có marks, thẳng nếu không.
  // ------------------------------------------------------------------
  const listPath = `${params.outputAbsPath}.concat.txt`;
  const segmentAbsPaths = params.segments.map((s) =>
    path.join(params.recordingRoot, s.file_path),
  );
  const concatBody =
    marks.length > 0
      ? buildInterleavedConcatList(params.segments, segmentAbsPaths, markPaths)
      : buildConcatList(params.segments, params.recordingRoot);
  await writeFile(listPath, concatBody, "utf8");

  // Cleanup helper — chạy cuối dù thành công hay thất bại.
  const cleanupTmp = async () => {
    await unlink(listPath).catch(() => undefined);
    for (const f of renderedMarkFiles) await unlink(f).catch(() => undefined);
  };

  // Offset trong concat stream ảo, tính từ started_at của segment
  // đầu tiên. `Date.parse`/`getTime()` hoạt động trên UTC millis —
  // TZ máy không ảnh hưởng.
  //
  // -t tổng: khi có marks, chèn thêm totalMarkDurationSeconds vào -t
  // để clip cuối bao TRỌN cả segment + mark. Nếu không cộng, ffmpeg
  // cắt clip tại target duration cũ → mất mark cuối hoặc segment cuối.
  const firstStart = Date.parse(params.segments[0].started_at);
  const ssSeconds = Math.max(0, (params.cutStart.getTime() - firstStart) / 1000);
  const targetDurationSeconds = Math.max(
    0,
    (params.cutEnd.getTime() - params.cutStart.getTime()) / 1000,
  );
  const tSeconds = targetDurationSeconds + totalMarkDurationSeconds;

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
      await cleanupTmp();
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
    // Dọn concat list + marks tmp ngay khi lỗi spawn.
    await cleanupTmp();
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

  // Dọn concat list + marks tmp — thành công hay thất bại đều dọn.
  await cleanupTmp();

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

export async function probeDurationSeconds(bin: string, filePath: string): Promise<number | null> {
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
