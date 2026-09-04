import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  SYSTEM_JOB_CLOSE_ORPHAN_SEGMENTS,
  errorMessage,
  recordSystemJob,
  truncateForDetail,
} from "@/lib/system/job-log";
import { OPEN_SEGMENT_MAX_AGE_SECONDS } from "@/lib/order-proof/open-segment-verdict";

/**
 * Dọn row `camera_recording_files` mồ côi: `ended_at IS NULL` nhưng đã
 * quá cũ để còn là segment đang ghi.
 *
 * Vì sao cần job này chứ không chỉ sửa resolver:
 *
 * Resolver giờ đã bỏ qua row mồ côi khi cắt clip
 * (`open-segment-verdict.ts`), nên bug 92 đơn không tái diễn. Nhưng row
 * mồ côi vẫn là DỮ LIỆU SAI nằm lại trong bảng: nó nói "camera này có
 * một segment không bao giờ kết thúc". Mọi thứ khác đọc bảng đó — thống
 * kê phủ sóng bằng chứng, KPI, ước lượng dung lượng — đều thấy con số
 * sai. Dọn ở đây là dọn tận gốc dữ liệu.
 *
 * Vì sao dọn ở cloud chứ không ở agent:
 *
 * Agent CÓ đường vá (boot recovery, `segment-index.ts` mục 2-3) nhưng nó
 * chỉ vá được row mà file tương ứng CÒN TRÊN Ổ và chỉ chạy LÚC BOOT. Row
 * mồ côi 27/08 ở kho Đại Kim sống sót 8 ngày vì agent chạy liên tục
 * không boot lại, và tới khi boot thì file đã có thể bị cleanup xóa theo
 * retention. Cloud thì luôn nhìn thấy row, không phụ thuộc ổ đĩa hay
 * lịch khởi động của máy kho.
 *
 * Nguyên tắc: chỉ ĐÓNG row, KHÔNG xóa. Xóa sẽ làm mất dấu vết camera
 * từng ghi tới thời điểm đó.
 *
 * `ended_at` lấy `started_at` của segment kế tiếp cùng camera — NHƯNG
 * chỉ khi hai segment thật sự liền kề. Nếu cách nhau quá
 * `MAX_ORPHAN_DURATION_SECONDS` thì đó không phải "ffmpeg rolled" mà là
 * "camera ngừng ghi rồi lâu sau mới ghi lại", và khoảng giữa KHÔNG có
 * video.
 *
 * Đây không phải giả định: row mồ côi ở kho Đại Kim có segment kế tiếp
 * cách nó 8 NGÀY (27/08 07:25 → 04/09 08:39 — camera ngừng ghi cả tuần).
 * Nếu ghi thẳng `ended_at` = mốc segment kế, row đó sẽ tự nhận là một
 * segment dài 8 ngày và PHỦ mọi cửa sổ clip trong khoảng ấy như thể có
 * video — resolver sẽ ghép một file không tồn tại vào clip. Sai đó tệ
 * hơn hẳn bug đang sửa.
 */

/**
 * Row phải cũ hơn ngần này mới bị đụng tới. Đặt gấp đôi ngưỡng mà
 * resolver dùng để phân loại mồ côi: job này GHI vào DB nên phải bảo thủ
 * hơn hàm chỉ đọc. Vùng đệm đó bảo đảm job không bao giờ đóng nhầm một
 * segment mà resolver vẫn còn coi là đang ghi.
 */
export const ORPHAN_SEGMENT_MIN_AGE_SECONDS = OPEN_SEGMENT_MAX_AGE_SECONDS * 2;

/**
 * Trần độ dài một segment mồ côi được phép nhận.
 *
 * Segment ffmpeg dài ~60s. Cho phép tới 5 phút để chịu ca ổ SMB lag hay
 * ffmpeg treo trước khi watchdog giết. Vượt trần này thì khoảng cách tới
 * segment kế KHÔNG phải thời lượng ghi — nó là quãng camera ngừng hẳn.
 * Lúc đó chốt độ dài 0: "có mở, không biết ghi được bao lâu" là điều duy
 * nhất ta biết chắc, và nó không phủ nhầm cửa sổ clip nào.
 */
const MAX_ORPHAN_DURATION_SECONDS = 300;

/** Trần số row xử lý một lần chạy — chặn job ngốn hết bộ nhớ nếu có sự cố hàng loạt. */
const MAX_ROWS_PER_RUN = 500;

export interface OrphanRow {
  id: string;
  organization_id: string;
  camera_id: string;
  started_at: string;
}

export interface CloseOrphanResult {
  ok: true;
  /** Số row đã đóng. */
  closed: number;
  /** Số row mồ côi tìm thấy (có thể > closed nếu chạm trần). */
  found: number;
  /** true khi chạm trần MAX_ROWS_PER_RUN — còn row cho lần chạy sau. */
  truncated: boolean;
  cutoff_iso: string;
}

export interface CloseOrphanError {
  ok: false;
  error: string;
  message: string;
}

export interface CloseOrphanOptions {
  client?: ReturnType<typeof createAdminClient>;
  /** Mốc "bây giờ" — test tiêm vào để khỏi phụ thuộc đồng hồ thật. */
  now?: Date;
}

/**
 * Tìm ended_at đúng cho một row mồ côi: `started_at` của segment kế tiếp
 * cùng camera. Trả null nếu không có segment nào sau nó.
 */
async function findNextSegmentStart(
  admin: ReturnType<typeof createAdminClient>,
  row: OrphanRow,
): Promise<string | null> {
  const { data } = await admin
    .from("camera_recording_files")
    .select("started_at")
    .eq("organization_id", row.organization_id)
    .eq("camera_id", row.camera_id)
    .eq("source", "agent")
    .gt("started_at", row.started_at)
    .order("started_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.started_at as string | undefined) ?? null;
}

export async function closeOrphanSegments(
  options: CloseOrphanOptions = {},
): Promise<CloseOrphanResult | CloseOrphanError> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = options.client ?? createAdminClient();
  } catch (err) {
    return { ok: false, error: "client_init_failed", message: errorMessage(err) };
  }

  const now = options.now ?? new Date();
  const cutoffIso = new Date(
    now.getTime() - ORPHAN_SEGMENT_MIN_AGE_SECONDS * 1000,
  ).toISOString();

  const { data: rows, error } = await admin
    .from("camera_recording_files")
    .select("id, organization_id, camera_id, started_at")
    .is("ended_at", null)
    .eq("source", "agent")
    .lt("started_at", cutoffIso)
    .order("started_at", { ascending: true })
    .limit(MAX_ROWS_PER_RUN + 1);

  if (error) {
    return { ok: false, error: "select_failed", message: truncateForDetail(error.message) };
  }

  const all = (rows ?? []) as OrphanRow[];
  const truncated = all.length > MAX_ROWS_PER_RUN;
  const batch = truncated ? all.slice(0, MAX_ROWS_PER_RUN) : all;

  let closed = 0;
  for (const row of batch) {
    const nextStart = await findNextSegmentStart(admin, row);
    const startedMs = Date.parse(row.started_at);
    // Segment kế chỉ dùng được khi nó LIỀN KỀ. Cách quá xa nghĩa là
    // camera ngừng ghi giữa chừng — khoảng đó không có video, không được
    // để row này nhận vơ. Không có segment kế cũng vào nhánh độ dài 0:
    // bịa một con số từ now sai hơn (row có thể cũ hàng tuần).
    const nextMs = nextStart ? Date.parse(nextStart) : NaN;
    const gapSeconds = Number.isFinite(nextMs)
      ? Math.round((nextMs - startedMs) / 1000)
      : Number.POSITIVE_INFINITY;
    const adjacent = gapSeconds >= 0 && gapSeconds <= MAX_ORPHAN_DURATION_SECONDS;

    const endedAt = adjacent ? (nextStart as string) : row.started_at;
    const durationSeconds = adjacent ? gapSeconds : 0;

    // Điều kiện `.is("ended_at", null)` giữ nguyên trong UPDATE: nếu
    // agent vừa kịp đóng row này giữa lúc job chạy, ta KHÔNG ghi đè số
    // của agent (nó chính xác hơn — đo từ file thật).
    const { error: upErr } = await admin
      .from("camera_recording_files")
      .update({ ended_at: endedAt, duration_seconds: durationSeconds })
      .eq("id", row.id)
      .is("ended_at", null);

    if (upErr) {
      console.error("[orphan-segments] update failed", {
        id: row.id,
        message: upErr.message,
      });
      continue;
    }
    closed += 1;
  }

  if (closed > 0 || batch.length > 0) {
    console.warn(
      `[orphan-segments] đóng ${closed}/${batch.length} row segment mồ côi ` +
        `(ended_at NULL, started_at < ${cutoffIso})`,
    );
  }

  return { ok: true, closed, found: all.length, truncated, cutoff_iso: cutoffIso };
}

export interface CloseOrphanJobOptions extends CloseOrphanOptions {
  /** Client cho việc ghi sổ (chỉ test tiêm vào). */
  jobClient?: ReturnType<typeof createAdminClient>;
}

/**
 * Một lần chạy job, có ghi sổ — cùng ba bảo đảm với runCleanupClipsJob:
 * luôn ghi đúng 1 dòng, ghi sổ hỏng không làm hỏng việc dọn, ngoại lệ
 * được ghi sổ rồi ném tiếp.
 */
export async function runCloseOrphanSegmentsJob(
  options: CloseOrphanJobOptions = {},
): Promise<CloseOrphanResult | CloseOrphanError> {
  const startedAt = Date.now();
  const { jobClient, ...runOptions } = options;

  let result: CloseOrphanResult | CloseOrphanError;
  try {
    result = await closeOrphanSegments(runOptions);
  } catch (err) {
    await recordSystemJob(
      {
        jobName: SYSTEM_JOB_CLOSE_ORPHAN_SEGMENTS,
        ok: false,
        durationMs: Date.now() - startedAt,
        detail: { error: "exception", message: errorMessage(err) },
      },
      { client: jobClient },
    );
    throw err;
  }

  await recordSystemJob(
    {
      jobName: SYSTEM_JOB_CLOSE_ORPHAN_SEGMENTS,
      ok: result.ok,
      durationMs: Date.now() - startedAt,
      // Chỉ số đếm + mốc thời gian: system_jobs là bảng platform-global,
      // không mang camera_id / đường dẫn file. Xem job-log.ts.
      detail: result.ok
        ? {
            closed: result.closed,
            found: result.found,
            truncated: result.truncated,
            cutoff_iso: result.cutoff_iso,
          }
        : { error: result.error, message: truncateForDetail(result.message) },
    },
    { client: jobClient },
  );

  return result;
}
