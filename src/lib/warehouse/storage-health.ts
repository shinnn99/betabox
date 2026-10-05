import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET_TTL_HOURS } from "@/lib/watch/config";
import { diskDaysLeft, parseSelfReport } from "@/lib/warehouse/self-report";
import { loadFleetRows } from "@/lib/warehouse/fleet";

/**
 * Sức chứa bằng chứng của MỘT kho — bản cho tenant (/dashboard/storage).
 *
 * ══ KHÁC BẢN PLATFORM Ở CHỖ NÀO ══
 *
 * Trang platform (/platform/storage) trả lời "Betacom đang trả tiền bao nhiêu
 * cho Supabase". Trang này trả lời câu khác hẳn, của người quản kho: "bằng
 * chứng của tôi còn giữ được bao lâu nữa". Hai câu đó nhìn vào hai cái ổ khác
 * nhau:
 *
 *   * Ổ máy kho  — nơi giữ SEGMENT GỐC, hạn theo `retention_days`. Đây mới là
 *     bằng chứng. Ổ đầy = mất bằng chứng thật.
 *   * Bucket Supabase — CACHE 72h cho clip đã cắt. Hết hạn KHÔNG mất gì, vì
 *     cắt lại được từ segment gốc.
 *
 * Nên thứ tự trình bày ở trang tenant là ổ kho trước, Supabase sau — ngược
 * với trang platform. Đảo thứ tự là dạy người quản kho lo nhầm chỗ.
 *
 * ══ CON SỐ QUAN TRỌNG NHẤT: retention_days CÓ VỪA Ổ KHÔNG ══
 *
 * Đo thật tại kho Đại Kim 02/10/2026: ổ 465 GB, đang ghi ~40 GB/ngày →
 * sức chứa vật lý ~11-15 ngày. Nhưng `retention_days` đặt 30. Cấu hình đang
 * HỨA gấp đôi thứ cái ổ làm được, và không màn hình nào nói ra điều đó.
 *
 * `capacityDays` dưới đây là phép chia thẳng tổng ổ / tốc độ ghi. Nó KHÔNG
 * phải dự báo chính xác (tốc độ ghi đổi theo mùa vụ, theo số camera), nhưng
 * sai số đó không quan trọng: thứ cần phát hiện là lệch GẤP ĐÔI, không phải
 * lệch 10%.
 */

type Admin = ReturnType<typeof createAdminClient>;

export interface AgentDiskView {
  agentId: string;
  code: string | null;
  name: string | null;
  online: boolean;
  lastSeenAt: string | null;
  /** Mốc bản tự khai gần nhất — "Cập nhật lúc…" của thẻ ổ đĩa. */
  reportAt: string | null;
  /** null = máy chạy bản ≤ 0.12.x, chưa biết tự khai ổ đĩa. */
  disk: {
    freeBytes: number;
    totalBytes: number;
    usedBytes: number;
    /** Dung lượng thực của toàn bộ thư mục RECORDING_DIR; null = agent chưa đo được. */
    recordingBytes: number | null;
    freePct: number;
    /** Tốc độ ghi mỗi ngày; null = agent chưa đủ số liệu để tính. */
    bytesPerDay: number | null;
    /** Còn mấy ngày thì ĐẦY ổ. null = chưa tính được. */
    daysLeft: number | null;
    /**
     * Ổ này giữ được tối đa bao nhiêu NGÀY bản ghi, nếu dọn đều đặn.
     * So với `retentionDays` ra được câu "đặt 30 mà ổ chỉ đủ 15".
     */
    capacityDays: number | null;
  } | null;
}

export interface DailyRecordingRow {
  day: string;
  segments: number;
  bytes: number;
  /**
   * Số đoạn đã đóng file mà không có dung lượng.
   *
   * BẢN CHẤT THẬT (truy ra 02/10/2026, KHÁC hẳn giả định ban đầu "agent bản cũ
   * không đo được"): **7.950/7.954 dòng như vậy là DÒNG GHI TRÙNG.** Mỗi video
   * bị ghi vào sổ hai lần dưới hai đường dẫn — một theo mã camera
   * (`dahua_01/...`, nguồn `legacy_nextjs`, CÓ đủ kích thước) và một theo mã
   * bàn (`CTC01/...`, nguồn `agent`, kích thước NULL). Cùng tên file, cùng
   * camera, cùng mốc bắt đầu chính xác tới giây.
   *
   * Nên dung lượng KHÔNG hề mất — nó nằm ở dòng sinh đôi. Thứ sai là số ĐẾM:
   * ngày 21/09 hiện 744 video trong khi thật sự chỉ có 372.
   *
   * Lỗi dừng hẳn từ 22/09, đúng lúc bỏ đường ghi `legacy_nextjs`: từ đó trùng
   * = 0 và chỉ còn nguồn `agent`. Không cần sửa agent.
   */
  segmentsWithoutSize: number;
  /**
   * Số đoạn ĐANG QUAY ngay lúc đọc (`ended_at` null): chưa đóng file nên chưa
   * có dung lượng, vài phút nữa sẽ có.
   *
   * Tách khỏi `segmentsWithoutSize` là bắt buộc, không phải chi li: gộp hai
   * thứ này thì ngày HÔM NAY lúc nào cũng bị gắn nhãn "máy kho bản cũ" chỉ vì
   * có 1-2 đoạn đang quay — một lời cảnh báo sai mỗi ngày, và cảnh báo sai
   * lặp lại là cách nhanh nhất để người dùng thôi đọc cảnh báo.
   */
  segmentsRecording: number;
}

export interface StorageHealthView {
  retentionDays: number | null;
  agents: AgentDiskView[];
  /** Dung lượng ghi theo từng ngày — để thấy nhịp thật, không phải trung bình. */
  daily: DailyRecordingRow[];
  /** Clip đang nằm trên bucket Supabase CỦA RIÊNG org này. */
  bucket: {
    ttlHours: number;
    clips: number;
    bytes: number;
  };
  /**
   * Cảnh báo đã diễn giải sẵn — trang chỉ việc hiện, không tự suy luận.
   * Tính ở server để trang tenant và mọi chỗ khác không mỗi nơi một ngưỡng.
   */
  warnings: StorageWarning[];
}

export interface StorageWarning {
  kind: "disk_full_soon" | "retention_exceeds_capacity" | "no_self_report" | "agent_offline";
  severity: "crit" | "warn";
  agentCode: string | null;
  message: string;
  action: string;
}

/** Agent coi là sống nếu ping trong 5 phút — khớp reaper pg_cron. */
const ONLINE_MS = 5 * 60_000;

/** Dưới ngần này ngày trống là đỏ. */
const DISK_CRIT_DAYS = 3;
const DISK_WARN_DAYS = 7;

/**
 * Dựng cảnh báo từ số liệu — HÀM THUẦN, không truy vấn.
 *
 * Tách riêng để test được từng ngưỡng mà không cần dựng DB giả. Đây cũng là
 * nơi DUY NHẤT quyết định "thế nào là đáng lo", nên sửa ngưỡng chỉ sửa ở đây.
 */
export function buildStorageWarnings(
  agents: AgentDiskView[],
  retentionDays: number | null,
): StorageWarning[] {
  const out: StorageWarning[] = [];

  for (const a of agents) {
    if (!a.disk) {
      out.push({
        kind: "no_self_report",
        severity: "warn",
        agentCode: a.code,
        message: `Máy kho ${a.code ?? "—"} chưa báo dung lượng ổ đĩa.`,
        action: "Cập nhật máy kho lên bản 0.13.0 trở lên để theo dõi được ổ đĩa.",
      });
      continue;
    }

    const d = a.disk;
    if (d.daysLeft !== null && d.daysLeft < DISK_WARN_DAYS) {
      const crit = d.daysLeft < DISK_CRIT_DAYS;
      out.push({
        kind: "disk_full_soon",
        severity: crit ? "crit" : "warn",
        agentCode: a.code,
        // Nói thẳng hậu quả: ổ đầy thì agent NGỪNG GHI, không phải "chạy chậm".
        message:
          `Ổ máy kho ${a.code ?? "—"} còn khoảng ${d.daysLeft} ngày là đầy ` +
          `(đã dùng ${gb(d.usedBytes)} GB / ${gb(d.totalBytes)} GB).`,
        action: "Ổ đầy thì máy kho NGỪNG GHI và mất bằng chứng từ lúc đó. Giảm số ngày lưu, hoặc nâng dung lượng ổ.",
      });
    }

    // Cấu hình hứa nhiều hơn ổ làm được. Chỉ báo khi lệch rõ (>20%) để không
    // kêu inh ỏi vì sai số đo tốc độ ghi.
    if (
      retentionDays !== null &&
      d.capacityDays !== null &&
      d.capacityDays < retentionDays * 0.8
    ) {
      out.push({
        kind: "retention_exceeds_capacity",
        severity: "warn",
        agentCode: a.code,
        message:
          `Đang cài đặt giữ ${retentionDays} ngày, nhưng dữ liệu hiện tại chỉ đủ ` +
          `${d.capacityDays} ngày — bản ghi có thể bị xoá sớm hơn ` +
          // Nói rõ lệch BAO NHIÊU: "thiếu 18.4 ngày" buộc phải đối chiếu, còn
          // "không đủ" thì đọc xong vẫn không biết có nghiêm trọng không.
          `${Math.round((retentionDays - d.capacityDays) * 10) / 10} ngày so với cài đặt.`,
        action:
          "Bản ghi cũ sẽ bị dọn sớm hơn số ngày đã đặt — đặt 30 ngày không có nghĩa là tìm lại được đơn của 30 ngày trước. Giảm số ngày lưu cho khớp, hoặc nâng ổ.",
      });
    }

    if (!a.online) {
      out.push({
        kind: "agent_offline",
        severity: "warn",
        agentCode: a.code,
        message: `Máy kho ${a.code ?? "—"} đang không kết nối — số liệu bên dưới là lần báo cuối.`,
        action: "Kiểm máy kho còn bật và còn mạng không.",
      });
    }
  }

  // Nặng trước.
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "crit" ? -1 : 1));
}

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Số ngày bản ghi mà ổ này chứa nổi. Hàm thuần. */
export function capacityDaysOf(totalBytes: number, bytesPerDay: number | null): number | null {
  if (!bytesPerDay || bytesPerDay <= 0) return null;
  return Math.floor((totalBytes / bytesPerDay) * 10) / 10;
}

/** Số ngày lấy dung lượng ghi theo ngày. */
const DAILY_WINDOW_DAYS = 14;

/**
 * Dung lượng ghi theo ngày — gộp Ở SQL, không kéo dòng thô về Node.
 *
 * BẢN ĐẦU SAI THẾ NÀO (sửa 02/10/2026): kéo thẳng `camera_recording_files` rồi
 * gộp bằng JS, kèm ghi chú "đã lọc org + 14 ngày nên tập nhỏ". Tập KHÔNG nhỏ —
 * kho Đại Kim có 11.158 dòng/14 ngày. PostgREST chặn ở 1.000 dòng mặc định nên
 * trang chỉ nhận 1.000 dòng CŨ NHẤT, vẽ ra đúng 2 ngày và tổng "1000 video /
 * 7.3 GB". Nhìn như kho ngừng hoạt động, trong khi kho chạy đủ 13 ngày.
 *
 * Bài học: con số 1000 tròn trĩnh trong một tổng là dấu hiệu chạm trần trang,
 * không phải số thật.
 */
async function readDailyUsage(
  admin: Admin,
  organizationId: string,
): Promise<DailyRecordingRow[]> {
  const { data, error } = await admin.rpc("recording_daily_usage", {
    p_organization_id: organizationId,
    p_days: DAILY_WINDOW_DAYS,
  });
  // Hàm chưa có (migration chưa chạy) → trả rỗng chứ KHÔNG rơi về cách đọc
  // thô cũ: cách cũ cho ra con số SAI mà trông vẫn hợp lý, tệ hơn là không có
  // biểu đồ. Trang hiện "chưa có bản ghi" và phần ổ đĩa vẫn chạy bình thường.
  if (error) return [];
  return ((data as Array<{
    day: string;
    segments: number | string;
    bytes: number | string;
    segments_without_size: number | string;
    segments_recording?: number | string;
  }> | null) ?? []).map((r) => ({
    day: String(r.day).slice(0, 10),
    // bigint qua JSON về dạng chuỗi — ép số ở ranh giới RPC, đừng tin kiểu.
    segments: Number(r.segments),
    bytes: Number(r.bytes),
    segmentsWithoutSize: Number(r.segments_without_size),
    // Hàm bản cũ chưa có cột này → 0, trang chỉ mất phần chú thích "đang
    // quay" chứ không hiện sai.
    segmentsRecording: Number(r.segments_recording ?? 0),
  }));
}

/**
 * Đọc sức chứa bằng chứng của một org.
 *
 * MỌI truy vấn ở đây đều lọc `organization_id` — kho này không được thấy một
 * byte nào của kho khác.
 */
export async function readStorageHealth(
  admin: Admin,
  organizationId: string,
): Promise<StorageHealthView> {
  const [fleet, orgRes, daily, clipsRes] = await Promise.all([
    loadFleetRows(admin, { orgIds: [organizationId] }).catch(() => ({
      rows: [],
      selfReportAvailable: false,
    })),
    admin.from("organizations").select("retention_days").eq("id", organizationId).maybeSingle(),
    readDailyUsage(admin, organizationId),
    admin
      .from("order_proof_clips")
      .select("clip_size_bytes")
      .eq("organization_id", organizationId)
      .not("bucket_path", "is", null),
  ]);

  const nowMs = Date.now();
  const agents: AgentDiskView[] = fleet.rows
    .filter((r) => r.status === "active")
    .map((r) => {
      const report = parseSelfReport(r.self_report);
      const raw = report?.disk ?? null;
      const usedBytes = raw ? Math.max(raw.total_bytes - raw.free_bytes, 0) : 0;
      return {
        agentId: r.id,
        code: r.code,
        name: r.name,
        online: r.last_seen_at !== null && nowMs - Date.parse(r.last_seen_at) <= ONLINE_MS,
        lastSeenAt: r.last_seen_at,
        reportAt: r.self_report_at,
        disk: raw
          ? {
              freeBytes: raw.free_bytes,
              totalBytes: raw.total_bytes,
              usedBytes,
              // Phép đo thư mục được nhớ tối đa một giờ. Nếu cleanup vừa chạy,
              // số cũ có thể lớn hơn tổng đã dùng hiện tại; kẹp để UI không
              // hiện phân rã vô lý trong cửa sổ ngắn đó.
              recordingBytes:
                raw.recording_bytes === null ? null : Math.min(raw.recording_bytes, usedBytes),
              freePct:
                raw.total_bytes > 0
                  ? Math.round((raw.free_bytes / raw.total_bytes) * 1000) / 10
                  : 0,
              bytesPerDay: raw.bytes_per_day,
              daysLeft: diskDaysLeft(raw),
              capacityDays: capacityDaysOf(raw.total_bytes, raw.bytes_per_day),
            }
          : null,
      };
    });

  const bucketBytes = ((clipsRes.data ?? []) as Array<{ clip_size_bytes: number | null }>).reduce(
    (n, c) => n + (c.clip_size_bytes ?? 0),
    0,
  );

  const retentionDays = (orgRes.data?.retention_days as number | null) ?? null;

  return {
    retentionDays,
    agents,
    // RPC đã ORDER BY day DESC — mới nhất trước, trang tự đảo khi vẽ.
    daily,
    bucket: {
      ttlHours: BUCKET_TTL_HOURS,
      clips: (clipsRes.data ?? []).length,
      bytes: bucketBytes,
    },
    warnings: buildStorageWarnings(agents, retentionDays),
  };
}
