import "server-only";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  SYSTEM_JOB_CLEANUP_CLIPS,
  SYSTEM_JOB_CLOSE_ORPHAN_SEGMENTS,
  errorMessage,
} from "@/lib/system/job-log";

/**
 * Chín mục kiểm hạ tầng Betabox.
 *
 * Bối cảnh: tuần 08/2026 có 3 sự cố phát hiện muộn — egress Supabase tràn
 * 103%, cron dọn clip chết 5 ngày, agent kho im 19 giờ. Không cái nào có
 * cảnh báo. Trang hiển thị không cứu được vì "có trang cũng không ai mở".
 *
 * BA RÀNG BUỘC CỨNG của module này (route /check chạy mỗi 15 phút, route
 * /status chạy mỗi lần platform admin mở trang):
 *
 *  1. KHÔNG throw. Mọi mục kiểm lỗi nguồn dữ liệu → `status: "unknown"`
 *     kèm lời giải thích. Một mục hỏng không được kéo chết 5 mục kia —
 *     hệ theo dõi mà tự sập thì tệ hơn không có.
 *  2. KHÔNG chạm đường agent. Mọi truy vấn đều nhẹ (một dòng, hoặc vài
 *     chục dòng bảng nhỏ), có timeout `queryTimeoutMs`, và chỉ ĐỌC.
 *  3. KHÔNG đoán số. Mục nào chưa có nguồn dữ liệu thật thì trả "unknown"
 *     và nói thẳng là chưa có nguồn — không bịa ngưỡng để ô hiện màu
 *     xanh cho đẹp.
 *
 * ĐỒNG HỒ KHÔNG PHẢI LÀ MỐC — HOẠT ĐỘNG NGHIỆP VỤ MỚI LÀ (13/08/2026).
 *
 * Bản trước hỏi "bây giờ có phải giờ làm không" bằng một khung giờ khai
 * trong `warehouses.operating_hours`. Hỏng ở hai chỗ: khung đó do người
 * dựng hệ tự suy ra từ dữ liệu chứ không ai ở kho xác nhận, và mọi kho sau
 * đều phải nhớ khai — quên là bị bắn cảnh báo mỗi đêm.
 *
 * Thay bằng câu hỏi đo được: "kho có tiếp tục ĐÓNG GÓI sau khi bằng chứng
 * ngừng về không". `packing_events` là nguồn ĐỘC LẬP với agent — scan đến
 * từ trình duyệt ở trạm đóng gói, agent không ghi bảng này (grep
 * warehouse-agent/: 0 file). Nên:
 *
 *   * agent chết giữa ca  → kho vẫn quét đơn → lastScan chạy tiếp, lastSeen
 *     đứng lại → hiệu số lớn dần → báo.
 *   * kho đóng cửa bình thường → cả hai cùng dừng → hiệu số ≈ 0 → im lặng,
 *     không cần biết mấy giờ.
 *
 * Và hiệu số đó KHÔNG phải "im bao lâu" — nó là LƯỢNG BẰNG CHỨNG ĐÃ MẤT,
 * thứ duy nhất đáng gọi người dậy. Không múi giờ, không DST, không khai báo.
 */

/**
 * "skipped" = mục này KHÔNG được đánh giá lần chạy này vì kho không có
 * hoạt động để đối chiếu. Khác hẳn "ok" (đã đo, mọi thứ tốt) và khác
 * "unknown" (đáng ra đo được mà không đo được). Ba trạng thái này mà gộp
 * lại thì ô xanh lúc 3 giờ sáng sẽ nói dối: nó không chứng minh gì cả.
 *
 * `skipped` KHÔNG BAO GIỜ sinh cảnh báo — xem needsAlert/incidentUnknowns.
 */
export type CheckStatus = "ok" | "warn" | "crit" | "unknown" | "skipped";

/**
 * Hai loại `unknown`, và phân biệt được chúng là điều kiện để cảnh báo
 * `unknown` không biến thành nhiễu:
 *
 *   - "structural": KHÔNG có nguồn dữ liệu, biết trước, không bao giờ đo
 *     được ở phiên bản hiện tại (egress, disk kho). Trạng thái đứng yên —
 *     gửi mỗi 6 giờ là dạy người trực phớt lờ bot.
 *   - "incident": mục VỐN đo được mà đột nhiên không đo được (DB lỗi,
 *     timeout, thiếu env). Đây là tin thật, và là đúng kịch bản 10/08:
 *     Supabase hỏng → mấy mục dùng DB lặng lẽ chuyển unknown → không ai
 *     biết gì.
 */
export type UnknownKind = "structural" | "incident";

/**
 * Một đối tượng cụ thể bên trong một mục kiểm: MỘT agent, MỘT camera.
 *
 * VÌ SAO CẦN: bản đầu gộp mọi agent về đúng một dòng tệ nhất và nối mọi mã
 * camera vào một chuỗi `join(", ")`. Với một kho thì không lộ; ba kho cùng
 * chết thì ô chỉ kể tên một kho, sửa xong kho đó ô vẫn đỏ mà không ai biết
 * vì sao. Dữ liệu per-đối-tượng vốn đã được tính rồi — chỉ đang bị bóp lại
 * trước khi trả về.
 *
 * ĐƯỜNG CẢNH BÁO KHÔNG ĐỌC TRƯỜNG NÀY. `sendSystemAlert` chỉ ăn
 * `status`/`value`/`message`, nên thêm/bớt entity không bao giờ đổi nội dung
 * tin Lark hay bộ chống-spam. Đây là ràng buộc cố ý: trang hiển thị được
 * phép giàu lên, con cảnh báo thì không được lung lay.
 */
export interface CheckEntity {
  kind: "agent" | "camera" | "org";
  /** Khoá React + dedupe. Rơi về `code` nếu bảng chưa trả id. */
  id: string;
  /** Mã hiển thị: mã agent hoặc mã camera. */
  code: string;
  /** Tổ chức sở hữu — để gộp thành bảng theo kho và dựng link. */
  orgId: string;
  status: CheckStatus;
  /** Một câu về riêng đối tượng này. */
  detail: string;
  /** Việc cần làm. Chỉ đặt ở đối tượng đang xấu. */
  action?: string;
  /**
   * Nhóm phân loại nội bộ của mục kiểm — bảng theo kho đếm theo cột này.
   * Camera: "ok" | "failing_long" | "failing_short" | "stale".
   */
  bucket?: string;
  /** Con số của riêng đối tượng này (vd: số clip lỗi). Chỉ mục nào cần mới đặt. */
  count?: number;
  /**
   * Tuổi của tín hiệu gần nhất từ đối tượng này (ms): heartbeat với agent,
   * probe với camera.
   *
   * TÁCH KHỎI `status` có chủ đích. `status` trả lời "có mất bằng chứng
   * không" — câu hỏi để cảnh báo. Trường này trả lời "cái này còn đang bật
   * không" — câu hỏi để HIỂN THỊ. Ban đêm agent tắt: status "ok" (không mất
   * gì) nhưng signalAgeMs 3 giờ (đang tắt). Gộp hai thứ lại thì ô đầu trang
   * hoặc nói dối là "1/1 online", hoặc bắn báo động giả.
   */
  signalAgeMs?: number;
}

export interface SystemCheck {
  /** Khoá ổn định — chống spam và trang hiển thị đều bám vào chuỗi này. */
  key: string;
  status: CheckStatus;
  /** Số/nhãn ngắn để hiện trong ô. */
  value: string;
  /** Câu giải thích cho người trực. */
  message: string;
  /** Chỉ có nghĩa khi status = "unknown". */
  unknownKind?: UnknownKind;
  /** Chi tiết theo từng đối tượng. Chỉ mục agent/camera có. */
  entities?: CheckEntity[];
}

export const CHECK_KEYS = {
  egress: "supabase_egress",
  cronCleanup: "cron_cleanup",
  cronOrphanSegments: "cron_orphan_segments",
  agentHeartbeat: "agent_heartbeat",
  cameraProbe: "camera_probe",
  recording: "recording_freshness",
  clipFailures: "clip_failures",
  vps: "vps_resources",
  storage: "storage_usage",
  warehouseDisk: "warehouse_disk",
} as const;

/**
 * Ngưỡng gom một chỗ. Đổi ở đây, không rải số ma trong thân hàm.
 */
export const CHECK_CONFIG = {
  /**
   * Trần thời gian cho MỘT truy vấn. Ngắn có chủ đích: route này chạy nền,
   * thà trả "unknown vì quá hạn" còn hơn giữ connection pool trong lúc
   * đường agent đang cần.
   */
  queryTimeoutMs: 4_000,

  cronCleanup: {
    // Cron chạy 03:00 hàng ngày → 26h là "đã lỡ đúng một nhịp + 2h nhân
    // nhượng". 48h là "lỡ hai nhịp" — lúc đó chắc chắn hỏng, không phải
    // chạy trễ.
    warnHours: 26,
    critHours: 48,
  },

  cronOrphanSegments: {
    // Chạy 03:30 hàng ngày — cùng nhịp với cron dọn clip nên dùng cùng
    // ngưỡng. Hậu quả nhẹ hơn (dữ liệu thống kê sai, không phải bucket
    // phình) nhưng "lỡ hai nhịp" vẫn là hỏng chứ không phải trễ.
    warnHours: 26,
    critHours: 48,
  },

  agentHeartbeat: {
    /**
     * ĐƠN VỊ: phút ĐÓNG GÓI trôi qua SAU KHI agent im — tức lượng bằng
     * chứng đã mất — chứ không phải "im bao lâu". Xem evidenceLostMs().
     *
     * 30 phút đóng gói không có clip đã là mất mát thật với khách; 2 giờ
     * là mất gần một buổi.
     */
    warnMinutes: 30,
    critMinutes: 120,
    /**
     * Nuốt chênh lệch thứ tự lúc kho đóng cửa bình thường: agent tắt xong,
     * nhân viên còn bấm nốt vài đơn cuối. Agent ping 30s/lần nên lệch thật
     * chỉ cỡ phút; 15 phút là rộng rãi.
     *
     * Đánh đổi đã biết và đã chấp nhận: agent chết trong 15 phút cuối của
     * ca sẽ không được báo. Đổi lại là không còn báo động giả mỗi tối.
     */
    graceMinutes: 15,
    /**
     * Mốc HIỂN THỊ (không phải cảnh báo): ping mới hơn ngần này thì coi là
     * máy đang bật. Ping 30s/lần nên 5 phút = lỡ 10 nhịp. Chỉ dùng cho ô
     * "Agent online" ở đầu trang — xem CheckEntity.signalAgeMs.
     */
    onlineWithinMinutes: 5,
  },

  cameraProbe: {
    // "Camera lỗi quá 2 giờ" — đo bằng probe_consecutive_fails, xem
    // ghi chú dài trong checkCameraProbe().
    failingMinutes: 120,
    probeIntervalSeconds: 30,
    // Probe cũ hơn mốc này = agent không còn probe camera đó nữa, số
    // liệu đứng hình → không kết luận, để mục agent_heartbeat lo.
    staleProbeMinutes: 15,
  },

  recording: {
    /**
     * ĐƠN VỊ: phút ĐÓNG GÓI trôi qua sau segment cuối — lượng bằng chứng
     * đã mất, không phải "segment cũ bao lâu".
     *
     * Segment dài 60 giây, do cloud quyết định — src/lib/camera/
     * active-credentials.ts trả `segment_seconds: 60`. Hai ngưỡng dưới đây
     * suy ra TỪ con số đó chứ không phải số tròn chọn cho đẹp: 10 phút =
     * lỡ ~10 segment liên tiếp trong lúc kho vẫn làm việc. Đổi
     * segment_seconds thì rà lại cả hai.
     */
    segmentSeconds: 60,
    warnMinutes: 10,
    critMinutes: 30,
    /**
     * Hẹp hơn grace của heartbeat (15 phút) có chủ đích: segment rơi mỗi
     * 60 giây nên độ trễ tự nhiên giữa "quét đơn" và "file xuống đĩa" chỉ
     * cỡ một segment, không cần rộng như đường heartbeat.
     */
    graceMinutes: 3,
    /**
     * Mỗi org một truy vấn `limit(1)` theo index — rẻ, nhưng là O(số org).
     * Quá trần này thì dừng và trả unknown thay vì nã một loạt truy vấn
     * trong route chạy nền.
     */
    maxOrgs: 20,
  },

  clipFailures: {
    windowHours: 24,
    // Một clip lỗi là một đơn hàng không có bằng chứng — đáng biết ngay,
    // nhưng chưa phải dựng người dậy. Từ 5 trong 24 giờ thì không còn là
    // ca lẻ nữa mà là hỏng hệ thống (encode, dung lượng, credentials).
    warnCount: 1,
    critCount: 5,
    /** Trần số dòng kéo về. Chạm trần thì báo "≥ N", không đọc tiếp. */
    fetchLimit: 200,
  },

  /**
   * Mục nào được phép báo động khi mất nguồn dữ liệu.
   *
   * Hai cửa phải cùng mở thì mới gửi: cờ ở đây (mục này về nguyên tắc có
   * đáng báo unknown không) VÀ `unknownKind === "incident"` (lần này mất
   * nguồn vì sự cố, không phải vì bản chất). Chỉ có cờ là chưa đủ —
   * camera_probe bật cờ nhưng vẫn có trạng thái unknown-đứng-yên
   * (camera ngừng ghi, agent không probe nữa), gửi cái đó mỗi 6 giờ là
   * đúng thứ mình đang tránh.
   */
  alertOnUnknown: {
    [CHECK_KEYS.egress]: false,
    [CHECK_KEYS.warehouseDisk]: false,
    // Dung lượng Storage: cùng lý do với egress — Supabase không công khai
    // mẫu số hạn mức. Xem checkStorageUsage().
    [CHECK_KEYS.storage]: false,
    [CHECK_KEYS.cronCleanup]: true,
    [CHECK_KEYS.cronOrphanSegments]: true,
    [CHECK_KEYS.agentHeartbeat]: true,
    [CHECK_KEYS.cameraProbe]: true,
    [CHECK_KEYS.recording]: true,
    [CHECK_KEYS.clipFailures]: true,
    [CHECK_KEYS.vps]: true,
  } as Record<string, boolean>,

  /**
   * Từ ngần này mục mất nguồn CÙNG MỘT LẦN CHẠY thì gộp thành một tin
   * duy nhất: nhiều mục chết cùng lúc là dấu hiệu hạ tầng chung (Supabase,
   * mạng), không phải mấy lỗi lẻ. Bắn ba tin rời cho một nguyên nhân là
   * cách nhanh nhất khiến người ta tắt thông báo.
   */
  unknownAggregateFrom: 2,

  vps: {
    diskWarnPct: 85,
    diskCritPct: 95,
    // RAM: đề bài không cho ngưỡng. Chọn 90/97 vì Node có GC — RAM cao
    // không nguy như disk đầy (disk đầy là ffmpeg chết + build chết).
    // Sửa được nếu VPS Contabo hay chạm 90% lúc bình thường.
    ramWarnPct: 90,
    ramCritPct: 97,
  },
} as const;

// ============================================================================
// Định dạng
// ============================================================================

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "không rõ";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} phút`;
  const hours = Math.floor(mins / 60);
  const restMin = mins % 60;
  if (hours < 24) return restMin === 0 ? `${hours} giờ` : `${hours} giờ ${restMin} phút`;
  const days = Math.floor(hours / 24);
  const restHour = hours % 24;
  return restHour === 0 ? `${days} ngày` : `${days} ngày ${restHour} giờ`;
}

function pct(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((used / total) * 1000) / 10;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ============================================================================
// Bọc an toàn: mọi mục kiểm đi qua đây
// ============================================================================

/**
 * Chạy một mục kiểm, nuốt mọi lỗi thành `unknown`.
 *
 * Đây là chỗ thực thi ràng buộc số 1. Không mục kiểm nào được throw ra
 * ngoài, kể cả khi nguồn dữ liệu (DB, filesystem) hỏng hoàn toàn.
 */
export async function safeCheck(
  key: string,
  fn: () => Promise<SystemCheck>,
): Promise<SystemCheck> {
  try {
    return await fn();
  } catch (err) {
    return {
      key,
      status: "unknown",
      value: "—",
      message: `Không kiểm được: ${errorMessage(err)}`,
      // Mục này đo được ở lần chạy bình thường; hỏng ở đây là SỰ CỐ, phải
      // báo, không phải "chưa có nguồn".
      unknownKind: "incident",
    };
  }
}

/** Timeout cho truy vấn Supabase — dùng chung cho mọi mục. */
function queryTimeout(): AbortSignal {
  return AbortSignal.timeout(CHECK_CONFIG.queryTimeoutMs);
}

type Admin = ReturnType<typeof createAdminClient>;

// ============================================================================
// 1. Egress Supabase
// ============================================================================

/**
 * CHƯA CÓ NGUỒN SỐ LIỆU — và đây là kết luận từ kiểm chứng, không phải bỏ sót.
 *
 * Đã thử (12/08/2026):
 *   * Management API: `searchDocs` không có endpoint nào trả egress-so-với-
 *     hạn-mức. Chỉ có `/v1/projects/{ref}/usage/api-count` (đếm request)
 *     và `/v1/projects/{ref}/analytics/endpoints/metrics` (Prometheus).
 *   * Endpoint Prometheus `<ref>.supabase.co/customer/v1/privileged/metrics`
 *     gọi thật, HTTP 200, 299 metric. Có `db_transmit_bytes` và
 *     `node_network_transmit_bytes_total` — nhưng đó là counter băng thông
 *     của INSTANCE DB, không gồm Storage (mà clip video tải từ Storage mới
 *     là phần ăn egress lớn nhất của Betabox), và không có mẫu số hạn mức
 *     để tính phần trăm.
 *
 * Nói cách khác: con số 103% từng làm hệ chết chỉ tồn tại ở trang billing
 * của dashboard, không có API công khai. Bịa một con số gần đúng ở đây còn
 * nguy hơn để trống — người trực sẽ tin ô màu xanh.
 *
 * Đường đi tiếp (chờ chốt): đếm lượt cấp signed URL × dung lượng clip để
 * tự ước lượng egress Storage. Cần bảng đếm mới + cột dung lượng clip
 * (hiện `order_proof_clips` không có cột nào ghi bytes).
 */
export function checkEgress(): SystemCheck {
  return {
    key: CHECK_KEYS.egress,
    status: "unknown",
    unknownKind: "structural",
    value: "chưa đo được",
    message:
      "Chưa có nguồn dữ liệu: Supabase không công khai API trả egress so với hạn mức " +
      "(đã kiểm Management API + endpoint Prometheus — chỉ có băng thông instance DB, " +
      "không gồm Storage, không có mẫu số hạn mức). Vẫn phải xem tay ở dashboard Supabase.",
  };
}

// ============================================================================
// 2. Cron nền (dọn clip, dọn segment mồ côi)
// ============================================================================

interface JobRow {
  ran_at: string;
  ok: boolean;
}

/** Câu chữ riêng của từng job — phần LOGIC dùng chung ở checkCronJob(). */
interface CronJobCopy {
  /** Tên job trong câu cảnh báo, VD "Cron dọn clip". */
  label: string;
  /** Tên systemd unit để người trực biết kiểm ở đâu. */
  unit: string;
  /** Hậu quả nếu job chết — nói cho người trực biết vì sao phải quan tâm. */
  consequence: string;
}

/**
 * Đọc `system_jobs` — sổ chạy mà cron ghi mỗi lần chạy.
 *
 * Hỏi HAI câu, không phải một:
 *   a. Lần chạy THÀNH CÔNG gần nhất cách đây bao lâu? (tuổi → warn/crit)
 *   b. Lần chạy gần nhất có lỗi không?
 *
 * Vì sao cần câu (b): nếu chỉ đo tuổi dòng mới nhất, một cron chạy đều
 * nhưng lần nào cũng lỗi sẽ luôn xanh — đúng cái bẫy "có ghi log nhưng
 * log nói thất bại mà không ai đọc".
 *
 * Dùng chung cho mọi job nền: thân hàm này KHÔNG biết job nào, chỉ nhận
 * job_name + câu chữ. Job nền thứ hai thêm vào chỉ cần một dòng cấu hình,
 * không chép lại 70 dòng logic warn/crit — chép ra là chép luôn cả bug.
 */
export async function checkCronJob(
  admin: Admin,
  now: Date,
  opts: {
    key: string;
    jobName: string;
    warnHours: number;
    critHours: number;
    copy: CronJobCopy;
  },
): Promise<SystemCheck> {
  const { key, jobName, warnHours, critHours, copy } = opts;

  const { data: lastOkRows, error: okErr } = await admin
    .from("system_jobs")
    .select("ran_at, ok")
    .eq("job_name", jobName)
    .eq("ok", true)
    .order("ran_at", { ascending: false })
    .limit(1)
    .abortSignal(queryTimeout());
  if (okErr) throw new Error(okErr.message);

  const { data: lastRows, error: lastErr } = await admin
    .from("system_jobs")
    .select("ran_at, ok")
    .eq("job_name", jobName)
    .order("ran_at", { ascending: false })
    .limit(1)
    .abortSignal(queryTimeout());
  if (lastErr) throw new Error(lastErr.message);

  const lastOk = (lastOkRows as JobRow[] | null)?.[0] ?? null;
  const last = (lastRows as JobRow[] | null)?.[0] ?? null;

  if (!lastOk) {
    return {
      key,
      status: "crit",
      value: "chưa từng chạy xong",
      message: last
        ? `Có ${formatAge(now.getTime() - new Date(last.ran_at).getTime())} trước một lần chạy nhưng THẤT BẠI, và chưa lần nào thành công.`
        : `Chưa có lần chạy nào được ghi nhận. Kiểm tra systemd timer ${copy.unit} trên VPS.`,
    };
  }

  const ageMs = now.getTime() - new Date(lastOk.ran_at).getTime();
  const ageHours = ageMs / 3_600_000;
  const age = formatAge(ageMs);

  if (ageHours > critHours) {
    return {
      key,
      status: "crit",
      value: age,
      message: `${copy.label} không chạy xong đã ${age} (quá ${critHours}h). ${copy.consequence}`,
    };
  }
  if (ageHours > warnHours) {
    return {
      key,
      status: "warn",
      value: age,
      message: `${copy.label} lỡ nhịp — lần chạy xong gần nhất ${age} trước (quá ${warnHours}h).`,
    };
  }
  // Chạy đúng nhịp, nhưng lần gần nhất có thể vẫn lỗi.
  if (last && !last.ok) {
    return {
      key,
      status: "warn",
      value: `${age} (lần cuối lỗi)`,
      message: `Lần chạy gần nhất THẤT BẠI, dù ${age} trước vẫn còn một lần chạy xong. Xem cột detail trong system_jobs.`,
    };
  }
  return {
    key,
    status: "ok",
    value: age,
    message: `${copy.label} chạy xong ${age} trước.`,
  };
}

export async function checkCronCleanup(admin: Admin, now: Date): Promise<SystemCheck> {
  return checkCronJob(admin, now, {
    key: CHECK_KEYS.cronCleanup,
    jobName: SYSTEM_JOB_CLEANUP_CLIPS,
    warnHours: CHECK_CONFIG.cronCleanup.warnHours,
    critHours: CHECK_CONFIG.cronCleanup.critHours,
    copy: {
      label: "Cron dọn clip",
      unit: "betabox-cleanup",
      consequence: "Bucket đang phình, kiểm systemd timer.",
    },
  });
}

/**
 * Job đóng row segment mồ côi (`ended_at` NULL quá cũ).
 *
 * Vì sao mục này đáng có cảnh báo riêng: job sinh ra sau sự cố 04/09/2026
 * — một row mồ côi chặn cắt clip 4 đơn ở kho Đại Kim, âm ỉ từ 28/07 mà
 * không ai biết. Nếu chính job dọn nó lại chết âm thầm thì ta lặp đúng
 * kiểu sự cố đã sinh ra nó (cron dọn clip từng chết 5 ngày vì không có sổ
 * nào để đọc).
 */
export async function checkCronOrphanSegments(
  admin: Admin,
  now: Date,
): Promise<SystemCheck> {
  return checkCronJob(admin, now, {
    key: CHECK_KEYS.cronOrphanSegments,
    jobName: SYSTEM_JOB_CLOSE_ORPHAN_SEGMENTS,
    warnHours: CHECK_CONFIG.cronOrphanSegments.warnHours,
    critHours: CHECK_CONFIG.cronOrphanSegments.critHours,
    copy: {
      label: "Cron dọn segment mồ côi",
      unit: "betabox-orphan-segments",
      consequence:
        "Row segment mồ côi tích lại làm sai thống kê phủ sóng bằng chứng.",
    },
  });
}

// ============================================================================
// Phạm vi theo dõi: tổ chức nào được tính, giờ vận hành ra sao
// ============================================================================

interface OrgRow {
  id: string;
  name: string | null;
}

interface WarehouseRow {
  organization_id: string;
  name: string | null;
}

export interface MonitoringScope {
  /** Org có `monitoring_enabled = true`. Rỗng nghĩa là không kiểm gì. */
  orgIds: string[];
  orgNameById: Map<string, string>;
  /** Tên kho active của từng org — bảng theo kho hiện ra, không chỉ tên org. */
  warehouseNamesByOrg: Map<string, string[]>;
  /**
   * Mốc đơn hàng được quét gần nhất của từng org. null = kho chưa đóng gói
   * đơn nào bao giờ.
   *
   * Đây là ĐỒNG HỒ THẬT của cả module: mọi kết luận "kho lẽ ra phải đang
   * ghi hình" đều đối chiếu với mốc này, không đối chiếu với giờ hệ thống.
   */
  lastScanByOrg: Map<string, string | null>;
}

/**
 * Vì sao phải lọc org: `AGENT_KHO_HN_01` là agent DEMO chạy trên máy dev
 * Betacom, cùng bảng với agent production. Ngày 12/08/2026 mục heartbeat
 * báo crit trong khi kho Đại Kim đang ghi hình bình thường — thủ phạm là
 * agent demo im. Một cảnh báo production mà tắt/bật theo việc ai đó gập
 * laptop là cảnh báo sẽ bị phớt lờ trong hai tuần.
 *
 * Cửa lọc đặt ở `organizations.monitoring_enabled` chứ không phải danh
 * sách mã agent cứng trong code: thêm khách mới không phải sửa file này,
 * và tắt theo dõi một org (org nội bộ, org đang onboard) là một câu UPDATE.
 */
export async function loadMonitoringScope(admin: Admin): Promise<MonitoringScope> {
  const { data: orgData, error: orgErr } = await admin
    .from("organizations")
    .select("id, name")
    .eq("monitoring_enabled", true)
    .abortSignal(queryTimeout());
  if (orgErr) throw new Error(orgErr.message);

  const orgs = (orgData as OrgRow[] | null) ?? [];
  const orgIds = orgs.map((o) => o.id);
  const orgNameById = new Map(orgs.map((o) => [o.id, o.name ?? o.id]));
  const scope: MonitoringScope = {
    orgIds,
    orgNameById,
    warehouseNamesByOrg: new Map(),
    lastScanByOrg: new Map(),
  };
  if (orgIds.length === 0) return scope;

  const { data: whData, error: whErr } = await admin
    .from("warehouses")
    .select("organization_id, name")
    .eq("status", "active")
    .in("organization_id", orgIds)
    .abortSignal(queryTimeout());
  if (whErr) throw new Error(whErr.message);

  for (const w of (whData as WarehouseRow[] | null) ?? []) {
    const names = scope.warehouseNamesByOrg.get(w.organization_id) ?? [];
    if (w.name) names.push(w.name);
    scope.warehouseNamesByOrg.set(w.organization_id, names);
  }

  // Mốc hoạt động: mỗi org một truy vấn `order by scanned_at desc limit 1`.
  // Index lookup, trả đúng một dòng. Không gộp thành một truy vấn lớn: gộp
  // thì phải kéo mọi đơn trong cửa sổ về rồi tự nhóm, mà câu hỏi chỉ cần
  // một mốc cho mỗi kho.
  const scans = await Promise.all(
    orgIds.map(async (orgId) => {
      const { data, error } = await admin
        .from("packing_events")
        .select("scanned_at")
        .eq("organization_id", orgId)
        .order("scanned_at", { ascending: false })
        .limit(1)
        .abortSignal(queryTimeout());
      if (error) throw new Error(error.message);
      return {
        orgId,
        at: (data as Array<{ scanned_at: string | null }> | null)?.[0]?.scanned_at ?? null,
      };
    }),
  );
  for (const s of scans) scope.lastScanByOrg.set(s.orgId, s.at);

  return scope;
}

/**
 * Bao nhiêu thời gian LÀM VIỆC trôi qua sau khi một tín hiệu ngừng về.
 *
 * `signalAt` là mốc cuối của thứ ta đang canh (heartbeat agent, segment ghi
 * hình). `lastScan` là mốc đơn hàng cuối được quét. Hiệu số dương nghĩa là
 * kho VẪN đóng gói sau khi tín hiệu tắt — tức là bằng chứng đã mất đúng
 * ngần đó thời gian.
 *
 * Trả null khi không kết luận được: kho chưa quét đơn nào bao giờ, hoặc
 * tín hiệu chưa từng có. Null KHÔNG phải 0 — 0 nghĩa là "đã đối chiếu, không
 * mất gì", null nghĩa là "không có gì để đối chiếu".
 *
 * `graceMs` nuốt chênh lệch thứ tự lúc kho đóng cửa bình thường: agent tắt
 * xong, nhân viên vẫn bấm nốt một đơn. Đánh đổi đã biết: agent chết trong
 * `graceMs` cuối cùng của ca sẽ không được báo.
 */
export function evidenceLostMs(
  signalAt: string | null,
  lastScan: string | null,
  graceMs: number,
): number | null {
  if (!signalAt || !lastScan) return null;
  const signal = new Date(signalAt).getTime();
  const scan = new Date(lastScan).getTime();
  if (!Number.isFinite(signal) || !Number.isFinite(scan)) return null;
  return Math.max(0, scan - signal - graceMs);
}

// ============================================================================
// 3. Heartbeat agent kho
// ============================================================================

interface AgentRow {
  id?: string | null;
  code: string | null;
  last_seen_at: string | null;
  organization_id: string;
}

function agentEntity(
  row: AgentRow,
  status: CheckStatus,
  detail: string,
  extra: { action?: string; signalAgeMs?: number | null } = {},
): CheckEntity {
  const code = row.code ?? "?";
  return {
    kind: "agent",
    id: row.id ?? code,
    code,
    orgId: row.organization_id,
    status,
    detail,
    ...(extra.action ? { action: extra.action } : {}),
    ...(extra.signalAgeMs == null ? {} : { signalAgeMs: extra.signalAgeMs }),
  };
}

/**
 * Agent nào để mất nhiều bằng chứng nhất quyết định trạng thái mục này —
 * một kho mù là một kho mất bằng chứng, không được để trung bình cộng che.
 *
 * Chỉ xét agent `status = 'active'` thuộc org đang bật theo dõi: agent đã
 * tắt có chủ đích, và agent demo, không phải sự cố.
 *
 * ĐO CÁI GÌ: không phải "im bao lâu" mà là "kho vẫn đóng gói bao lâu SAU
 * KHI agent im" — `evidenceLostMs(last_seen_at, lastScan)`. Xem ghi chú dài
 * ở đầu file. Hệ quả trực tiếp:
 *
 *   * Kho đóng cửa: heartbeat và scan cùng dừng → hiệu số 0 → im lặng, và
 *     im lặng ĐÚNG mà không cần ai khai giờ làm.
 *   * Agent chết giữa ca: scan chạy tiếp → hiệu số lớn dần → báo.
 *   * `now` không tham gia vào kết luận. Đây là điểm khác lớn nhất so với
 *     bản khung-giờ: hai mốc trong DB tự nói chuyện với nhau.
 *
 * `entities` trả về TỪNG agent (kể cả agent khoẻ) để trang dựng bảng theo
 * kho. Kết luận gộp ở `status`/`message` là thứ đi vào tin Lark.
 *
 * `preloaded`: scope do runSystemChecks nạp sẵn dùng chung với mục camera.
 * Bỏ trống thì hàm tự nạp (test gọi thẳng, và để hàm đứng một mình được).
 */
export async function checkAgentHeartbeat(
  admin: Admin,
  now: Date,
  preloaded?: MonitoringScope,
): Promise<SystemCheck> {
  const key = CHECK_KEYS.agentHeartbeat;
  const scope = preloaded ?? (await loadMonitoringScope(admin));

  if (scope.orgIds.length === 0) {
    return {
      key,
      status: "unknown",
      unknownKind: "structural",
      value: "không có tổ chức nào theo dõi",
      message:
        "Không tổ chức nào bật monitoring_enabled — không có gì để kiểm. " +
        "Nếu đây không phải chủ ý thì cờ đã bị tắt nhầm.",
    };
  }

  const { data, error } = await admin
    .from("warehouse_agents")
    .select("id, code, last_seen_at, organization_id")
    .eq("status", "active")
    .in("organization_id", scope.orgIds)
    .abortSignal(queryTimeout());
  if (error) throw new Error(error.message);

  const agents = (data as AgentRow[] | null) ?? [];
  if (agents.length === 0) {
    return {
      key,
      status: "unknown",
      // Không phải sự cố: truy vấn chạy tốt, hệ đúng là không có agent nào.
      unknownKind: "structural",
      value: "không có agent",
      message: "Không có agent nào đang active trong phạm vi theo dõi để kiểm.",
      entities: [],
    };
  }

  const graceMs = CHECK_CONFIG.agentHeartbeat.graceMinutes * 60_000;
  const warnMs = CHECK_CONFIG.agentHeartbeat.warnMinutes * 60_000;
  const critMs = CHECK_CONFIG.agentHeartbeat.critMinutes * 60_000;

  const evaluated = agents.map((agent) => {
    const lastScan = scope.lastScanByOrg.get(agent.organization_id) ?? null;
    const lostMs = evidenceLostMs(agent.last_seen_at, lastScan, graceMs);
    const wallMs = agent.last_seen_at
      ? Math.max(0, now.getTime() - new Date(agent.last_seen_at).getTime())
      : null;
    return { agent, lastScan, lostMs, wallMs };
  });

  // Chi tiết từng agent, dựng MỘT LẦN và dùng cho mọi nhánh kết luận.
  const entities: CheckEntity[] = evaluated.map(({ agent, lastScan, lostMs, wallMs }) => {
    if (!agent.last_seen_at) {
      // Chưa từng ping. Chỉ là sự cố nếu kho ĐÃ đóng gói đơn nào đó — kho
      // vừa tạo, chưa chạy, thì đây là việc onboard chứ không phải báo động.
      return lastScan
        ? agentEntity(agent, "crit", "Chưa từng gửi heartbeat, trong khi kho đã có đơn được đóng gói.", {
            action: "Máy kho đã cài agent chưa, secret có đúng không.",
          })
        : agentEntity(
            agent,
            "unknown",
            "Chưa từng gửi heartbeat, và kho cũng chưa đóng gói đơn nào — chưa kết luận được.",
            { action: "Kho mới thì cài agent và chạy thử một đơn." },
          );
    }
    const silence = wallMs === null ? "" : ` Lần ping cuối ${formatAge(wallMs)} trước.`;
    const age = { signalAgeMs: wallMs };
    if (lostMs === null) {
      // Có ping nhưng kho chưa quét đơn nào bao giờ → không có gì đối chiếu.
      return agentEntity(agent, "unknown", `Kho chưa đóng gói đơn nào nên không đối chiếu được.${silence}`, {
        ...age,
        action: "Chạy thử một đơn để hệ có mốc hoạt động mà so.",
      });
    }
    if (lostMs > critMs) {
      return agentEntity(agent, "crit", `Kho vẫn đóng gói ${formatAge(lostMs)} sau khi agent im.${silence}`, {
        ...age,
        action: "Bằng chứng của khoảng đó đã mất — gọi kiểm máy kho ngay.",
      });
    }
    if (lostMs > warnMs) {
      return agentEntity(agent, "warn", `Kho vẫn đóng gói ${formatAge(lostMs)} sau khi agent im.${silence}`, {
        ...age,
        action: `Theo dõi thêm; quá ${CHECK_CONFIG.agentHeartbeat.critMinutes} phút thì gọi kiểm máy kho.`,
      });
    }
    // lostMs === 0 ở ca kho đóng cửa bình thường: heartbeat và scan cùng
    // dừng. Câu chữ phải nói rõ là ĐÃ đối chiếu, không phải bỏ qua.
    return agentEntity(
      agent,
      "ok",
      lostMs === 0
        ? `Không có đơn nào bị đóng gói sau lần ping cuối.${silence}`
        : `Chỉ ${formatAge(lostMs)} đóng gói sau lần ping cuối, dưới ngưỡng.${silence}`,
      age,
    );
  });

  const crit = entities.filter((e) => e.status === "crit");
  const warn = entities.filter((e) => e.status === "warn");
  const unknown = entities.filter((e) => e.status === "unknown");
  const worstLost = Math.max(0, ...evaluated.map((e) => e.lostMs ?? 0));

  if (crit.length > 0) {
    return {
      key,
      status: "crit",
      value: `${crit.length}/${agents.length} agent mất bằng chứng`,
      message:
        `Kho vẫn đóng gói đơn sau khi agent im, mất tới ${formatAge(worstLost)} bằng chứng: ` +
        `${crit.map((e) => e.code).join(", ")}. Gọi kiểm máy kho ngay.`,
      entities,
    };
  }
  if (warn.length > 0) {
    return {
      key,
      status: "warn",
      value: `${warn.length}/${agents.length} agent lỡ nhịp`,
      message:
        `Kho đóng gói ${formatAge(worstLost)} sau khi agent im (ngưỡng ` +
        `${CHECK_CONFIG.agentHeartbeat.warnMinutes} phút): ${warn.map((e) => e.code).join(", ")}.`,
      entities,
    };
  }
  if (unknown.length === agents.length) {
    return {
      key,
      status: "unknown",
      // Không phải hạ tầng hỏng: đúng là chưa có hoạt động nào để đối chiếu.
      unknownKind: "structural",
      value: `${agents.length} agent chưa có mốc đối chiếu`,
      message:
        "Chưa kho nào đóng gói đơn để đối chiếu với heartbeat — không kết luận được. " +
        "Kho mới thì chạy thử một đơn.",
      entities,
    };
  }
  return {
    key,
    status: "ok",
    value: `${agents.length - unknown.length}/${agents.length} agent bám hoạt động`,
    message:
      `Không kho nào đóng gói đơn sau khi agent im quá ngưỡng ` +
      `(tệ nhất ${formatAge(worstLost)}).` +
      (unknown.length > 0 ? ` ${unknown.length} agent chưa có mốc đối chiếu.` : ""),
    entities,
  };
}

// ============================================================================
// 4. Camera probe
// ============================================================================

interface CameraRow {
  id?: string | null;
  camera_code: string | null;
  organization_id: string;
  last_probe_ok: boolean | null;
  last_probe_at: string | null;
  probe_consecutive_fails: number | null;
}

/** Nhóm phân loại camera — bảng theo kho đếm theo đúng bốn nhóm này. */
export const CAMERA_BUCKET = {
  ok: "ok",
  failingLong: "failing_long",
  failingShort: "failing_short",
  stale: "stale",
  /** Camera thuộc kho đang ngoài ca — có tồn tại, nhưng KHÔNG được đo lượt này. */
  skipped: "skipped",
} as const;

function cameraEntity(
  row: CameraRow,
  status: CheckStatus,
  bucket: string,
  detail: string,
  extra: { action?: string; signalAgeMs?: number } = {},
): CheckEntity {
  const code = row.camera_code ?? "?";
  return {
    kind: "camera",
    id: row.id ?? code,
    code,
    orgId: row.organization_id,
    status,
    detail,
    bucket,
    ...(extra.action ? { action: extra.action } : {}),
    ...(extra.signalAgeMs == null || !Number.isFinite(extra.signalAgeMs)
      ? {}
      : { signalAgeMs: extra.signalAgeMs }),
  };
}

/**
 * "Camera active nhưng last_probe_ok = false quá 2 giờ."
 *
 * Đo thời gian lỗi thế nào cho đúng: `cameras` không có cột "lỗi từ lúc
 * nào". Có `probe_consecutive_fails`, và backend tăng đúng 1 mỗi nhịp
 * probe thất bại, reset 0 khi probe được (xem
 * src/app/api/agent/camera-probe/route.ts:170-200). Nhịp probe là 30s
 * (warehouse-agent/src/config.ts:62). Vậy thời gian lỗi ≈ fails × 30s.
 *
 * Vì sao phải loại camera có probe CŨ: agent chỉ probe camera đang trong
 * desired-recording. Camera ngừng ghi sẽ giữ nguyên `last_probe_ok=false`
 * mãi mãi và counter đứng hình — nếu đếm cả nhóm đó thì mục này đỏ vĩnh
 * viễn và người trực sẽ học cách phớt lờ nó. Nhóm đó tách riêng, báo là
 * "số liệu cũ", và nếu agent chết thì mục agent_heartbeat mới là mục nói
 * đúng bản chất.
 */
export async function checkCameraProbe(
  admin: Admin,
  now: Date,
  preloaded?: MonitoringScope,
): Promise<SystemCheck> {
  const key = CHECK_KEYS.cameraProbe;
  const scope = preloaded ?? (await loadMonitoringScope(admin));

  if (scope.orgIds.length === 0) {
    return {
      key,
      status: "unknown",
      unknownKind: "structural",
      value: "không có tổ chức nào theo dõi",
      message: "Không tổ chức nào bật monitoring_enabled — không có camera nào để kiểm.",
    };
  }

  // Không còn cửa lọc theo giờ ở mục này, và không cần: agent chỉ probe
  // camera đang trong diện ghi hình, nên kho nghỉ thì `last_probe_at` tự cũ
  // đi và camera rơi vào nhóm "số liệu cũ" — im lặng đúng, bằng chính dữ
  // liệu, không bằng đồng hồ. Đó cũng là lý do độ tươi của probe được xét
  // TRƯỚC `last_probe_ok`: bản trước xét ok trước nên ban đêm mọi camera
  // hiện xanh dựa trên một lần probe thành công từ chiều hôm trước.
  //
  // Lấy cả camera đang khoẻ (bỏ `.eq("last_probe_ok", false)` của bản đầu):
  // không có mẫu số thì ô chỉ nói được "1 camera lỗi", người đọc không biết
  // là 1/2 hay 1/40 — hai tình huống khác hẳn nhau về mức độ.
  //
  // Chi phí: một dòng/camera active trong phạm vi theo dõi, 6 cột. Ở quy mô
  // hiện tại là vài chục dòng. Nếu vượt vài trăm camera thì đổi sang đếm
  // bằng RPC/aggregate — ràng buộc "truy vấn nhẹ" ở đầu file vẫn là luật.
  const { data, error } = await admin
    .from("cameras")
    .select("id, camera_code, organization_id, last_probe_ok, last_probe_at, probe_consecutive_fails")
    .eq("status", "active")
    .in("organization_id", scope.orgIds)
    .abortSignal(queryTimeout());
  if (error) throw new Error(error.message);

  const rows = (data as CameraRow[] | null) ?? [];
  if (rows.length === 0) {
    return {
      key,
      status: "unknown",
      // Truy vấn chạy tốt, hệ đúng là không có camera nào — giống nhánh
      // "không có agent". Trả ok ở đây là để ô xanh chứng minh bằng chỗ trống.
      unknownKind: "structural",
      value: "không có camera",
      message: "Không có camera nào đang active trong phạm vi theo dõi để kiểm.",
      entities: [],
    };
  }

  const staleMs = CHECK_CONFIG.cameraProbe.staleProbeMinutes * 60_000;
  const failingMs = CHECK_CONFIG.cameraProbe.failingMinutes * 60_000;
  const perFailMs = CHECK_CONFIG.cameraProbe.probeIntervalSeconds * 1_000;
  const failingHours = CHECK_CONFIG.cameraProbe.failingMinutes / 60;

  const stale: string[] = [];
  const failingLong: string[] = [];
  const failingShort: string[] = [];
  const entities: CheckEntity[] = [];

  for (const r of rows) {
    const code = r.camera_code ?? "?";
    const probeAge = r.last_probe_at
      ? now.getTime() - new Date(r.last_probe_at).getTime()
      : Number.POSITIVE_INFINITY;

    // ĐỘ TƯƠI TRƯỚC, kết quả sau. Probe cũ nghĩa là agent không còn probe
    // camera này — số liệu đứng hình, ok hay fail đều không kết luận được.
    if (probeAge > staleMs) {
      stale.push(code);
      entities.push(
        cameraEntity(
          r,
          // "skipped" chứ KHÔNG "unknown": đây là trạng thái không-đo-lượt-này,
          // không phải một câu hỏi chưa có đáp án. Để "unknown" thì mỗi đêm
          // kho nghỉ, MỌI camera sẽ đẻ ra một dòng trong danh sách sự cố —
          // đúng loại nhiễu vừa bỏ khung giờ để tránh, chỉ đổi chỗ.
          "skipped",
          CAMERA_BUCKET.stale,
          r.last_probe_at
            ? `Probe cũ hơn ${CHECK_CONFIG.cameraProbe.staleProbeMinutes} phút (lần cuối ${formatAge(probeAge)} trước) — agent không còn probe camera này.`
            : "Chưa từng được probe lần nào.",
          {
            action:
              "Bình thường khi kho nghỉ. Nếu kho đang chạy thì kiểm camera còn trong diện ghi hình không.",
            signalAgeMs: probeAge,
          },
        ),
      );
      continue;
    }
    if (r.last_probe_ok !== false) {
      entities.push(
        cameraEntity(r, "ok", CAMERA_BUCKET.ok, "Probe RTSP bình thường.", {
          signalAgeMs: probeAge,
        }),
      );
      continue;
    }
    const failingFor = (r.probe_consecutive_fails ?? 0) * perFailMs;
    if (failingFor >= failingMs) {
      failingLong.push(code);
      entities.push(
        cameraEntity(
          r,
          "warn",
          CAMERA_BUCKET.failingLong,
          `Không phản hồi RTSP ${formatAge(failingFor)} liên tục.`,
          {
            action: "Kiểm nguồn/mạng của camera, hoặc IP đã đổi mà chưa cập nhật.",
            signalAgeMs: probeAge,
          },
        ),
      );
    } else {
      failingShort.push(code);
      entities.push(
        cameraEntity(
          r,
          // Dưới ngưỡng thì KHÔNG phải sự cố — camera chớp tắt vài nhịp là
          // chuyện thường. Vẫn hiện trong bảng theo kho để thấy sớm.
          "ok",
          CAMERA_BUCKET.failingShort,
          `Đang lỗi ${formatAge(failingFor)}, chưa quá ngưỡng ${failingHours} giờ.`,
          { signalAgeMs: probeAge },
        ),
      );
    }
  }

  const staleNote =
    stale.length > 0
      ? ` (Thêm ${stale.length} camera có số liệu probe cũ — bình thường khi kho nghỉ.)`
      : "";

  if (failingLong.length > 0) {
    return {
      key,
      status: "warn",
      value: `${failingLong.length}/${rows.length} camera lỗi ≥ ${failingHours} giờ`,
      message:
        `Camera không phản hồi RTSP quá ${failingHours} giờ: ${failingLong.join(", ")}.` +
        staleNote,
      entities,
    };
  }
  if (failingShort.length > 0) {
    return {
      key,
      status: "ok",
      value: `${failingShort.length}/${rows.length} camera vừa lỗi`,
      message:
        `Có ${failingShort.length} camera đang lỗi nhưng chưa quá ${failingHours} giờ: ${failingShort.join(", ")}.` +
        staleNote,
      entities,
    };
  }
  if (stale.length === rows.length) {
    return {
      key,
      // MỌI camera đều số liệu cũ = không kho nào đang ghi hình. Đây là ca
      // "kho nghỉ", và nó tự đúng mà không cần biết mấy giờ.
      status: "skipped",
      value: `${stale.length}/${rows.length} camera không được probe`,
      message:
        `Không camera nào được probe trong ${CHECK_CONFIG.cameraProbe.staleProbeMinutes} phút qua — ` +
        "kho đang nghỉ hoặc không camera nào trong diện ghi hình. Không kết luận, không cảnh báo.",
      entities,
    };
  }
  if (stale.length > 0) {
    return {
      key,
      status: "unknown",
      // Một phần đứng yên chứ không phải hỏng: agent còn probe nhóm khác.
      // Nếu agent chết thật thì agent_heartbeat mới là mục nói đúng bản
      // chất — không nhân đôi cùng một sự cố.
      unknownKind: "structural",
      value: `${stale.length}/${rows.length} camera số liệu cũ`,
      message: `Có ${stale.length} camera không được probe quá ${CHECK_CONFIG.cameraProbe.staleProbeMinutes} phút (agent không còn probe nhóm này) — không kết luận được: ${stale.join(", ")}.`,
      entities,
    };
  }
  return {
    key,
    status: "ok",
    value: `${rows.length}/${rows.length} camera bình thường`,
    message: `Không có camera active nào đang ở trạng thái probe lỗi (${rows.length} camera đang được probe).`,
    entities,
  };
}

// ============================================================================
// 5. Ghi hình còn tươi không
// ============================================================================

function orgEntity(
  orgId: string,
  code: string,
  status: CheckStatus,
  detail: string,
  extra: { action?: string; count?: number } = {},
): CheckEntity {
  return {
    kind: "org",
    id: orgId,
    code,
    orgId,
    status,
    detail,
    ...(extra.action ? { action: extra.action } : {}),
    ...(extra.count === undefined ? {} : { count: extra.count }),
  };
}

/**
 * "Kho đóng gói đơn bao lâu SAU KHI segment cuối rơi xuống đĩa."
 *
 * VÌ SAO CẦN, dù đã có heartbeat agent và probe camera: hai mục kia đo
 * đường TÍN HIỆU (agent còn nói chuyện không, camera còn trả RTSP không),
 * mục này đo KẾT QUẢ (có file nào rơi xuống đĩa không). Agent sống + camera
 * trả RTSP mà ffmpeg treo thì hai mục kia vẫn xanh — và đó đúng là hình
 * dạng của sự cố watchdog runtime đã phải vá ở agent v0.7.0.
 *
 * ĐỐI CHIẾU VỚI SCAN, không với đồng hồ: "segment gần nhất 14 tiếng trước"
 * là con số đúng nhưng kết luận sai lúc 3 giờ sáng. Hỏi đúng câu là "có đơn
 * nào được đóng gói mà không có clip không" — và câu đó tự im lặng khi kho
 * nghỉ, tự lên tiếng khi kho chạy, không cần ai khai giờ làm.
 *
 * Mỗi org một truy vấn `order by ended_at desc limit 1` — index lookup, trả
 * đúng một dòng. Không gộp một truy vấn lớn có chủ đích: gộp thì phải kéo
 * mọi segment trong cửa sổ về rồi tự nhóm, và ở kho nhiều camera đó là hàng
 * nghìn dòng cho một câu hỏi có đáp án một dòng.
 */
export async function checkRecordingFreshness(
  admin: Admin,
  now: Date,
  preloaded?: MonitoringScope,
): Promise<SystemCheck> {
  const key = CHECK_KEYS.recording;
  const scope = preloaded ?? (await loadMonitoringScope(admin));

  if (scope.orgIds.length === 0) {
    return {
      key,
      status: "unknown",
      unknownKind: "structural",
      value: "không có tổ chức nào theo dõi",
      message: "Không tổ chức nào bật monitoring_enabled — không có kho nào để kiểm ghi hình.",
      entities: [],
    };
  }

  if (scope.orgIds.length > CHECK_CONFIG.recording.maxOrgs) {
    return {
      key,
      status: "unknown",
      // Không phải hạ tầng hỏng: cách đo hiện tại không co giãn tới quy mô
      // này. Nói thẳng để lần sau đổi sang aggregate, không âm thầm bỏ kiểm.
      unknownKind: "structural",
      value: `${scope.orgIds.length} kho, quá trần đo`,
      message:
        `Có ${scope.orgIds.length} tổ chức theo dõi, vượt trần ${CHECK_CONFIG.recording.maxOrgs} ` +
        "của cách đo hiện tại (mỗi org một truy vấn). Cần đổi sang aggregate trước khi mục này đo lại được.",
      entities: [],
    };
  }

  const graceMs = CHECK_CONFIG.recording.graceMinutes * 60_000;
  const warnMs = CHECK_CONFIG.recording.warnMinutes * 60_000;
  const critMs = CHECK_CONFIG.recording.critMinutes * 60_000;

  const rows = await Promise.all(
    scope.orgIds.map(async (orgId) => {
      const { data, error } = await admin
        .from("camera_recording_files")
        .select("ended_at")
        .eq("organization_id", orgId)
        .order("ended_at", { ascending: false })
        .limit(1)
        .abortSignal(queryTimeout());
      if (error) throw new Error(error.message);
      const endedAt = (data as Array<{ ended_at: string | null }> | null)?.[0]?.ended_at ?? null;
      return { orgId, endedAt };
    }),
  );

  const entities: CheckEntity[] = rows.map((r) => {
    const orgName = scope.orgNameById.get(r.orgId) ?? r.orgId;
    const lastScan = scope.lastScanByOrg.get(r.orgId) ?? null;
    const lostMs = evidenceLostMs(r.endedAt, lastScan, graceMs);
    const segNote = r.endedAt
      ? ` Segment cuối ${formatAge(Math.max(0, now.getTime() - new Date(r.endedAt).getTime()))} trước.`
      : "";

    if (!r.endedAt) {
      return lastScan
        ? orgEntity(
            r.orgId,
            "Ghi hình",
            "crit",
            "Chưa có segment nào, trong khi kho đã đóng gói đơn.",
            { action: "Kiểm agent đã bật ghi hình cho camera nào chưa." },
          )
        : orgEntity(
            r.orgId,
            "Ghi hình",
            "unknown",
            "Chưa có segment nào, và kho cũng chưa đóng gói đơn nào.",
            { action: "Kho mới thì chạy thử một đơn." },
          );
    }
    if (lostMs === null) {
      return orgEntity(
        r.orgId,
        "Ghi hình",
        "unknown",
        `Kho chưa đóng gói đơn nào nên không đối chiếu được.${segNote}`,
      );
    }
    if (lostMs > critMs) {
      return orgEntity(
        r.orgId,
        "Ghi hình",
        "crit",
        `Kho đóng gói ${formatAge(lostMs)} sau segment cuối.${segNote}`,
        { action: `Kho "${orgName}" không rơi file xuống đĩa — kiểm ffmpeg trên máy kho.` },
      );
    }
    if (lostMs > warnMs) {
      return orgEntity(
        r.orgId,
        "Ghi hình",
        "warn",
        `Kho đóng gói ${formatAge(lostMs)} sau segment cuối.${segNote}`,
        {
          action: `Ngưỡng ${CHECK_CONFIG.recording.warnMinutes} phút — theo dõi, quá ${CHECK_CONFIG.recording.critMinutes} phút thì gọi kiểm máy.`,
        },
      );
    }
    return orgEntity(
      r.orgId,
      "Ghi hình",
      "ok",
      lostMs === 0
        ? `Không đơn nào bị đóng gói sau segment cuối.${segNote}`
        : `Chỉ ${formatAge(lostMs)} đóng gói sau segment cuối, dưới ngưỡng.${segNote}`,
    );
  });

  const crit = entities.filter((e) => e.status === "crit");
  const warn = entities.filter((e) => e.status === "warn");
  const unknown = entities.filter((e) => e.status === "unknown");
  const names = (list: CheckEntity[]) =>
    list.map((e) => scope.orgNameById.get(e.orgId) ?? e.orgId).join(", ");

  if (crit.length > 0) {
    return {
      key,
      status: "crit",
      value: `${crit.length}/${rows.length} kho ngừng ghi`,
      message:
        `Kho đóng gói đơn quá ${CHECK_CONFIG.recording.critMinutes} phút mà không có segment mới: ${names(crit)}. ` +
        "Agent có thể vẫn sống — kiểm ffmpeg, không chỉ kiểm mạng.",
      entities,
    };
  }
  if (warn.length > 0) {
    return {
      key,
      status: "warn",
      value: `${warn.length}/${rows.length} kho lỡ nhịp`,
      message: `Kho đóng gói đơn quá ${CHECK_CONFIG.recording.warnMinutes} phút mà không có segment mới: ${names(warn)}.`,
      entities,
    };
  }
  if (unknown.length === rows.length) {
    return {
      key,
      status: "unknown",
      unknownKind: "structural",
      value: `${rows.length} kho chưa có mốc đối chiếu`,
      message: "Chưa kho nào đóng gói đơn để đối chiếu với ghi hình — không kết luận được.",
      entities,
    };
  }
  return {
    key,
    status: "ok",
    value: `${rows.length - unknown.length}/${rows.length} kho bám hoạt động`,
    message:
      "Không kho nào đóng gói đơn quá ngưỡng mà thiếu segment." +
      (unknown.length > 0 ? ` ${unknown.length} kho chưa có mốc đối chiếu.` : ""),
    entities,
  };
}

// ============================================================================
// 6. Clip đơn hàng sinh lỗi
// ============================================================================

interface ClipRow {
  organization_id: string;
  error_message: string | null;
}

/**
 * Đếm clip `status = 'failed'` trong 24 giờ gần nhất, theo từng kho.
 *
 * Đây là mục duy nhất đo thứ KHÁCH nhìn thấy: một clip lỗi là một đơn hàng
 * không có bằng chứng. Mọi mục khác đo hạ tầng và chỉ suy ra hậu quả.
 *
 * KHÔNG lọc theo giờ vận hành: clip sinh lỗi lúc 2 giờ sáng vẫn là một đơn
 * hàng hỏng vào sáng hôm sau. Khác hẳn heartbeat/probe — hai thứ đó chỉ có
 * nghĩa trong lúc kho đang chạy.
 */
export async function checkClipFailures(
  admin: Admin,
  now: Date,
  preloaded?: MonitoringScope,
): Promise<SystemCheck> {
  const key = CHECK_KEYS.clipFailures;
  const scope = preloaded ?? (await loadMonitoringScope(admin));

  if (scope.orgIds.length === 0) {
    return {
      key,
      status: "unknown",
      unknownKind: "structural",
      value: "không có tổ chức nào theo dõi",
      message: "Không tổ chức nào bật monitoring_enabled — không có clip nào để kiểm.",
      entities: [],
    };
  }

  const windowHours = CHECK_CONFIG.clipFailures.windowHours;
  const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
  const { data, error } = await admin
    .from("order_proof_clips")
    .select("organization_id, error_message")
    .eq("status", "failed")
    .gte("created_at", since)
    .in("organization_id", scope.orgIds)
    .limit(CHECK_CONFIG.clipFailures.fetchLimit)
    .abortSignal(queryTimeout());
  if (error) throw new Error(error.message);

  const rows = (data as ClipRow[] | null) ?? [];
  const capped = rows.length >= CHECK_CONFIG.clipFailures.fetchLimit;

  const byOrg = new Map<string, ClipRow[]>();
  for (const r of rows) {
    const list = byOrg.get(r.organization_id) ?? [];
    list.push(r);
    byOrg.set(r.organization_id, list);
  }

  // Entity cho MỌI org, kể cả org 0 lỗi: bảng theo kho cần ô "0 clip" hiện
  // ra chứ không phải ô trống — trống thì đọc thành "chưa đo".
  const entities: CheckEntity[] = scope.orgIds.map((orgId) => {
    const list = byOrg.get(orgId) ?? [];
    const n = list.length;
    if (n === 0) {
      return orgEntity(orgId, "Clip đơn hàng", "ok", `0 clip lỗi trong ${windowHours} giờ.`, {
        count: 0,
      });
    }
    // Lý do đầu tiên đủ để phân biệt "hỏng hàng loạt cùng một nguyên nhân"
    // với "vài ca lẻ" mà không phải mở log.
    const reason = list.find((r) => r.error_message)?.error_message;
    const detail =
      `${n} clip lỗi trong ${windowHours} giờ` + (reason ? ` — lý do đầu: ${reason}` : ".");
    const status: CheckStatus = n >= CHECK_CONFIG.clipFailures.critCount ? "crit" : "warn";
    return orgEntity(orgId, "Clip đơn hàng", status, detail, {
      count: n,
      action: "Xem cột error_message của order_proof_clips; nếu cùng một lý do thì là lỗi hệ thống, không phải ca lẻ.",
    });
  });

  const crit = entities.filter((e) => e.status === "crit");
  const warn = entities.filter((e) => e.status === "warn");
  const total = rows.length;
  const totalLabel = capped ? `≥ ${total}` : `${total}`;

  if (crit.length > 0) {
    const names = crit.map((e) => scope.orgNameById.get(e.orgId) ?? e.orgId).join(", ");
    return {
      key,
      status: "crit",
      value: `${totalLabel} clip lỗi / ${windowHours}h`,
      message: `Kho có từ ${CHECK_CONFIG.clipFailures.critCount} clip lỗi trở lên trong ${windowHours} giờ: ${names}. Đây là hỏng hệ thống, không phải ca lẻ.`,
      entities,
    };
  }
  if (warn.length > 0) {
    const names = warn.map((e) => scope.orgNameById.get(e.orgId) ?? e.orgId).join(", ");
    return {
      key,
      status: "warn",
      value: `${totalLabel} clip lỗi / ${windowHours}h`,
      message: `Có clip sinh lỗi trong ${windowHours} giờ ở kho: ${names}. Mỗi clip lỗi là một đơn hàng không có bằng chứng.`,
      entities,
    };
  }
  return {
    key,
    status: "ok",
    value: `0 clip lỗi / ${windowHours}h`,
    message: `Không clip đơn hàng nào sinh lỗi trong ${windowHours} giờ qua.`,
    entities,
  };
}

// ============================================================================
// 7. Disk + RAM của VPS
// ============================================================================

export interface OsLike {
  totalmem(): number;
  freemem(): number;
}
export type StatfsLike = (path: string) => Promise<{
  bsize: number;
  blocks: number;
  bavail: number;
}>;

/**
 * Đo ổ chứa app (đường dẫn process đang chạy) + RAM máy.
 *
 * `statfs` thay vì gọi `df`: không spawn process con trong route web.
 * `bavail` (block trống cho user thường) chứ không `bfree` — Linux giữ
 * ~5% cho root, dùng bfree sẽ báo còn trống trong khi app đã hết chỗ ghi.
 */
export async function checkVpsResources(deps: {
  now: Date;
  os?: OsLike;
  statfs?: StatfsLike;
  path?: string;
}): Promise<SystemCheck> {
  const key = CHECK_KEYS.vps;
  const osImpl = deps.os ?? os;
  const statfsImpl = deps.statfs ?? (statfs as unknown as StatfsLike);
  const target = deps.path ?? process.cwd();

  const fs = await statfsImpl(target);
  const totalBytes = fs.blocks * fs.bsize;
  const availBytes = fs.bavail * fs.bsize;
  const usedBytes = totalBytes - availBytes;
  const diskPct = pct(usedBytes, totalBytes);

  const totalMem = osImpl.totalmem();
  const freeMem = osImpl.freemem();
  const ramPct = pct(totalMem - freeMem, totalMem);

  const value = `Disk ${diskPct}% • RAM ${ramPct}%`;
  const detail = `Disk ${diskPct}% dùng (còn ${gib(availBytes)}/${gib(totalBytes)}), RAM ${ramPct}% dùng (còn ${gib(freeMem)}/${gib(totalMem)}).`;

  if (diskPct > CHECK_CONFIG.vps.diskCritPct) {
    return {
      key,
      status: "crit",
      value,
      message: `Ổ đĩa VPS gần đầy — ${detail} Ghi hình và build sẽ hỏng khi hết chỗ.`,
    };
  }
  if (ramPct > CHECK_CONFIG.vps.ramCritPct) {
    return { key, status: "crit", value, message: `RAM VPS gần cạn — ${detail}` };
  }
  if (diskPct > CHECK_CONFIG.vps.diskWarnPct) {
    return { key, status: "warn", value, message: `Ổ đĩa VPS cao — ${detail}` };
  }
  if (ramPct > CHECK_CONFIG.vps.ramWarnPct) {
    return { key, status: "warn", value, message: `RAM VPS cao — ${detail}` };
  }
  return { key, status: "ok", value, message: detail };
}

// ============================================================================
// 8. Dung lượng Storage
// ============================================================================

/**
 * CHƯA CÓ NGUỒN SỐ LIỆU — cùng một bức tường với egress, và cũng là kết
 * luận từ kiểm chứng chứ không phải bỏ sót.
 *
 * Tử số về nguyên tắc đếm được (cộng `metadata->>'size'` của storage.objects),
 * nhưng đó là quét toàn bucket trong một route chạy nền mỗi 15 phút — vi
 * phạm thẳng ràng buộc "truy vấn nhẹ" ở đầu file. MẪU SỐ thì không có API
 * nào trả: hạn mức lưu trữ của gói chỉ tồn tại ở trang billing.
 *
 * Một ô ghi "1.2 TB" mà không có "trên bao nhiêu" thì không trả lời được
 * câu duy nhất người trực cần hỏi — sắp đầy chưa. Để trống và nói thẳng.
 */
export function checkStorageUsage(): SystemCheck {
  return {
    key: CHECK_KEYS.storage,
    status: "unknown",
    unknownKind: "structural",
    value: "chưa đo được",
    message:
      "Chưa có nguồn dữ liệu: Supabase không công khai API trả dung lượng Storage so với hạn mức. " +
      "Đếm tay bằng cách quét storage.objects thì vi phạm ràng buộc truy vấn nhẹ của route chạy nền, " +
      "và vẫn thiếu mẫu số. Vẫn phải xem tay ở dashboard Supabase.",
  };
}

// ============================================================================
// 9. Disk máy kho
// ============================================================================

/**
 * CHƯA CÓ NGUỒN DỮ LIỆU — đã đọc code hai đầu để chắc, không suy đoán:
 *   * Agent chỉ gửi `{ping, time_drift_seconds}` trong heartbeat
 *     (warehouse-agent/src/heartbeat.ts).
 *   * Route heartbeat chỉ đọc `time_drift_seconds`, ghi `last_seen_at`
 *     (src/app/api/warehouse/heartbeat/route.ts:71-95).
 *   * `warehouse_agents` không có cột dung lượng nào.
 *
 * Đây đúng là cọc "disk guard vẫn chưa có": cleanup theo lịch giảm rủi ro
 * ổ đầy vì lý do lịch, không chặn ổ đầy vì lý do khác. Muốn có mục này thì
 * agent phải gửi kèm dung lượng ổ ghi trong heartbeat (thêm 2 field), cloud
 * thêm 2 cột — việc của agent v0.8.x, không làm lén ở đây.
 */
export function checkWarehouseDisk(): SystemCheck {
  return {
    key: CHECK_KEYS.warehouseDisk,
    status: "unknown",
    unknownKind: "structural",
    value: "chưa có nguồn",
    message:
      "Chưa có nguồn dữ liệu: agent không gửi dung lượng ổ trong heartbeat " +
      "(chỉ gửi time_drift_seconds) và warehouse_agents không có cột nào lưu. " +
      "Cần agent gửi kèm + thêm cột thì mục này mới đo được.",
  };
}

// ============================================================================
// Chạy cả 6 mục
// ============================================================================

export interface RunChecksDeps {
  client?: Admin;
  now?: Date;
  os?: OsLike;
  statfs?: StatfsLike;
  path?: string;
}

export interface SystemSnapshot {
  /** Sáu mục kiểm, thứ tự cố định. Đây là thứ đường cảnh báo Lark ăn. */
  checks: SystemCheck[];
  /**
   * Phạm vi theo dõi đã nạp. null = không nạp được (thiếu env, DB hỏng) —
   * lúc đó các mục dùng DB đã tự rơi vào unknown và bảng theo kho rỗng.
   */
  scope: MonitoringScope | null;
}

/**
 * Chạy song song, mỗi mục tự bọc lỗi. Thứ tự trả về CỐ ĐỊNH (egress → cron
 * → agent → camera → ghi hình → clip → VPS → storage → disk kho) để trang
 * hiển thị và tin cảnh báo luôn đọc cùng một thứ tự.
 *
 * Phạm vi theo dõi nạp MỘT LẦN ở đây rồi truyền xuống cả hai mục agent và
 * camera. Bản đầu để mỗi mục tự nạp — 4 truy vấn cho 2 câu hỏi giống nhau,
 * và hai mục có thể thấy hai phiên bản scope khác nhau nếu ai đó bật/tắt
 * monitoring_enabled đúng lúc đang chạy.
 */
export async function runSystemChecks(deps: RunChecksDeps = {}): Promise<SystemSnapshot> {
  const now = deps.now ?? new Date();
  // createAdminClient() có thể throw khi thiếu env — bọc để cả loạt
  // không chết theo, hai mục dùng DB sẽ tự trả unknown.
  let admin: Admin | null = null;
  let adminErr: string | null = null;
  try {
    admin = deps.client ?? createAdminClient();
  } catch (err) {
    adminErr = errorMessage(err);
  }

  // Nạp hụt thì KHÔNG chặn cả loạt: để `undefined` đi tiếp, từng mục sẽ tự
  // nạp lại, tự ném, và safeCheck biến thành unknown-incident — đúng đường
  // cũ, đúng tin cảnh báo cũ.
  let scope: MonitoringScope | null = null;
  if (admin) {
    try {
      scope = await loadMonitoringScope(admin);
    } catch (err) {
      console.warn("[system-check] không nạp được phạm vi theo dõi:", errorMessage(err));
    }
  }

  const needAdmin = (key: string, fn: (a: Admin) => Promise<SystemCheck>) =>
    safeCheck(key, async () => {
      if (!admin) {
        return {
          key,
          status: "unknown" as const,
          // Thiếu env / không dựng nổi client là sự cố hạ tầng, không phải
          // "mục này vốn không đo được".
          unknownKind: "incident" as const,
          value: "—",
          message: `Không tạo được kết nối Supabase: ${adminErr}`,
        };
      }
      return fn(admin);
    });

  const [cron, cronOrphan, agent, camera, recording, clips, vps] = await Promise.all([
    needAdmin(CHECK_KEYS.cronCleanup, (a) => checkCronCleanup(a, now)),
    needAdmin(CHECK_KEYS.cronOrphanSegments, (a) => checkCronOrphanSegments(a, now)),
    needAdmin(CHECK_KEYS.agentHeartbeat, (a) => checkAgentHeartbeat(a, now, scope ?? undefined)),
    needAdmin(CHECK_KEYS.cameraProbe, (a) => checkCameraProbe(a, now, scope ?? undefined)),
    needAdmin(CHECK_KEYS.recording, (a) =>
      checkRecordingFreshness(a, now, scope ?? undefined),
    ),
    needAdmin(CHECK_KEYS.clipFailures, (a) => checkClipFailures(a, now, scope ?? undefined)),
    safeCheck(CHECK_KEYS.vps, () =>
      checkVpsResources({ now, os: deps.os, statfs: deps.statfs, path: deps.path }),
    ),
  ]);

  return {
    checks: [
      checkEgress(),
      cron,
      cronOrphan,
      agent,
      camera,
      recording,
      clips,
      vps,
      checkStorageUsage(),
      checkWarehouseDisk(),
    ],
    scope,
  };
}

/** Mục cần báo động vì đo được và đang xấu. */
export function needsAlert(checks: SystemCheck[]): SystemCheck[] {
  return checks.filter((c) => c.status === "crit" || c.status === "warn");
}

/**
 * Mục MẤT NGUỒN DO SỰ CỐ và được phép báo.
 *
 * Hai cửa: cờ `alertOnUnknown[key]` và `unknownKind === "incident"`.
 * `supabase_egress`/`warehouse_disk` rớt ở cửa một; camera-đứng-hình và
 * "không có agent nào" rớt ở cửa hai.
 */
export function incidentUnknowns(checks: SystemCheck[]): SystemCheck[] {
  return checks.filter(
    (c) =>
      c.status === "unknown" &&
      c.unknownKind === "incident" &&
      CHECK_CONFIG.alertOnUnknown[c.key] === true,
  );
}

/** Khoá của tin gộp khi nhiều mục cùng mất nguồn. */
export const DATA_SOURCE_ALERT_KEY = "data_sources";

/**
 * Gộp nhiều mục mất nguồn thành MỘT tin crit.
 *
 * Trả null khi chưa tới ngưỡng gộp — lúc đó caller gửi từng mục như tin
 * unknown lẻ.
 */
export function buildDataSourceAlert(incidents: SystemCheck[]): SystemCheck | null {
  if (incidents.length < CHECK_CONFIG.unknownAggregateFrom) return null;
  const keys = incidents.map((c) => c.key).join(", ");
  return {
    key: DATA_SOURCE_ALERT_KEY,
    status: "crit",
    value: `${incidents.length} mục mất nguồn dữ liệu`,
    message:
      `Nhiều mục kiểm cùng lúc không đọc được dữ liệu (${keys}) — nghi Supabase/DB có sự cố ` +
      `chứ không phải lỗi lẻ của từng mục. Lý do mục đầu: ${incidents[0].message}`,
  };
}

/**
 * Thứ tự nặng dần: crit > warn > unknown > ok > skipped.
 *
 * `skipped` đứng CUỐI và chỉ thắng khi KHÔNG mục nào khác nói được gì —
 * lúc đó cả trang đang ngoài giờ, và nói "ok" là nói dối.
 */
export function worstOfStatuses(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes("crit")) return "crit";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("ok")) return "ok";
  return "skipped";
}

export function worstStatus(checks: SystemCheck[]): CheckStatus {
  return worstOfStatuses(checks.map((c) => c.status));
}
