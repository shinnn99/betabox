import "server-only";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { createAdminClient } from "@/lib/supabase/admin";
import { SYSTEM_JOB_CLEANUP_CLIPS, errorMessage } from "@/lib/system/job-log";
import {
  describeOperatingHours,
  isWithinOperatingHours,
  mergeOperatingHours,
  operatingMsBetween,
  parseOperatingHours,
  type OperatingHours,
} from "@/lib/system/business-hours";

/**
 * Sáu mục kiểm hạ tầng Betabox.
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
 */

/**
 * "skipped" = mục này KHÔNG được đánh giá lần chạy này vì đang ngoài giờ
 * vận hành của kho. Khác hẳn "ok" (đã đo, mọi thứ tốt) và khác "unknown"
 * (đáng ra đo được mà không đo được). Ba trạng thái này mà gộp lại thì ô
 * xanh lúc 3 giờ sáng sẽ nói dối: nó không chứng minh gì cả.
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
}

export const CHECK_KEYS = {
  egress: "supabase_egress",
  cronCleanup: "cron_cleanup",
  agentHeartbeat: "agent_heartbeat",
  cameraProbe: "camera_probe",
  vps: "vps_resources",
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

  agentHeartbeat: {
    // Agent ping ~30s/lần. 30 phút = lỡ ~60 nhịp: mất mạng thật, không
    // phải jitter. 2 giờ = kho đã ngừng ghi hình cả tiếng.
    //
    // ĐƠN VỊ ĐÃ ĐỔI (13/08/2026): hai số này đo phần im lặng NẰM TRONG giờ
    // vận hành của kho, không phải tuổi thô của last_seen_at. Kho Đại Kim
    // tắt máy sau ca nên tuổi thô mỗi sáng là ~14 giờ — đo thô thì crit
    // mỗi ngày. Xem src/lib/system/business-hours.ts.
    warnMinutes: 30,
    critMinutes: 120,
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
    [CHECK_KEYS.cronCleanup]: true,
    [CHECK_KEYS.agentHeartbeat]: true,
    [CHECK_KEYS.cameraProbe]: true,
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
// 2. Cron dọn clip
// ============================================================================

interface JobRow {
  ran_at: string;
  ok: boolean;
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
 */
export async function checkCronCleanup(admin: Admin, now: Date): Promise<SystemCheck> {
  const key = CHECK_KEYS.cronCleanup;

  const { data: lastOkRows, error: okErr } = await admin
    .from("system_jobs")
    .select("ran_at, ok")
    .eq("job_name", SYSTEM_JOB_CLEANUP_CLIPS)
    .eq("ok", true)
    .order("ran_at", { ascending: false })
    .limit(1)
    .abortSignal(queryTimeout());
  if (okErr) throw new Error(okErr.message);

  const { data: lastRows, error: lastErr } = await admin
    .from("system_jobs")
    .select("ran_at, ok")
    .eq("job_name", SYSTEM_JOB_CLEANUP_CLIPS)
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
        : "Chưa có lần chạy nào được ghi nhận. Kiểm tra systemd timer betabox-cleanup trên VPS.",
    };
  }

  const ageMs = now.getTime() - new Date(lastOk.ran_at).getTime();
  const ageHours = ageMs / 3_600_000;
  const age = formatAge(ageMs);

  if (ageHours > CHECK_CONFIG.cronCleanup.critHours) {
    return {
      key,
      status: "crit",
      value: age,
      message: `Cron dọn clip không chạy xong đã ${age} (quá ${CHECK_CONFIG.cronCleanup.critHours}h). Bucket đang phình, kiểm systemd timer.`,
    };
  }
  if (ageHours > CHECK_CONFIG.cronCleanup.warnHours) {
    return {
      key,
      status: "warn",
      value: age,
      message: `Cron dọn clip lỡ nhịp — lần chạy xong gần nhất ${age} trước (quá ${CHECK_CONFIG.cronCleanup.warnHours}h).`,
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
    message: `Cron dọn clip chạy xong ${age} trước.`,
  };
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
  operating_hours: unknown;
}

export interface MonitoringScope {
  /** Org có `monitoring_enabled = true`. Rỗng nghĩa là không kiểm gì. */
  orgIds: string[];
  orgNameById: Map<string, string>;
  /** null = theo dõi 24/7 (chưa cấu hình giờ, hoặc cấu hình sai). */
  hoursByOrg: Map<string, OperatingHours | null>;
  /** Tên kho có `operating_hours` sai định dạng — để nói ra, không nuốt. */
  invalidHoursWarehouses: string[];
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
    hoursByOrg: new Map(),
    invalidHoursWarehouses: [],
  };
  if (orgIds.length === 0) return scope;

  const { data: whData, error: whErr } = await admin
    .from("warehouses")
    .select("organization_id, name, operating_hours")
    .eq("status", "active")
    .in("organization_id", orgIds)
    .abortSignal(queryTimeout());
  if (whErr) throw new Error(whErr.message);

  const perOrg = new Map<string, Array<OperatingHours | null>>();
  for (const w of (whData as WarehouseRow[] | null) ?? []) {
    const parsed = parseOperatingHours(w.operating_hours);
    // Phân biệt "chưa cấu hình" (null trong DB — bình thường) với "cấu hình
    // SAI" (có giá trị mà đọc không ra). Cả hai đều về 24/7, nhưng ca thứ
    // hai phải hiện ra chữ, nếu không thì một dấu phẩy thừa trong JSON sẽ
    // âm thầm biến thành "kho này theo dõi 24/7" mà không ai biết.
    if (w.operating_hours != null && parsed === null) {
      scope.invalidHoursWarehouses.push(w.name ?? w.organization_id);
    }
    const list = perOrg.get(w.organization_id) ?? [];
    list.push(parsed);
    perOrg.set(w.organization_id, list);
  }

  for (const orgId of orgIds) {
    const list = perOrg.get(orgId);
    // Org không có kho active nào → không có giờ → 24/7.
    scope.hoursByOrg.set(orgId, list ? mergeOperatingHours(list) : null);
  }
  return scope;
}

/** Org đang trong giờ vận hành (hoặc theo dõi 24/7) tại thời điểm `now`. */
function orgsInWindow(scope: MonitoringScope, now: Date): string[] {
  return scope.orgIds.filter((id) => {
    const hours = scope.hoursByOrg.get(id) ?? null;
    return hours === null || isWithinOperatingHours(now, hours);
  });
}

/** Câu đuôi nói rõ có kho nào đang bị theo dõi 24/7 vì cấu hình hỏng. */
function invalidHoursNote(scope: MonitoringScope): string {
  if (scope.invalidHoursWarehouses.length === 0) return "";
  return ` (Cảnh báo cấu hình: operating_hours không đọc được ở kho ${scope.invalidHoursWarehouses.join(", ")} — đang theo dõi 24/7.)`;
}

// ============================================================================
// 3. Heartbeat agent kho
// ============================================================================

interface AgentRow {
  code: string | null;
  last_seen_at: string | null;
  organization_id: string;
}

/**
 * Agent nào im lâu nhất quyết định trạng thái mục này — một kho mù là
 * một kho mất bằng chứng, không được để trung bình cộng che đi.
 *
 * Chỉ xét agent `status = 'active'` thuộc org đang bật theo dõi: agent đã
 * tắt có chủ đích, và agent demo, không phải sự cố.
 *
 * "Im bao lâu" đo bằng phần im lặng NẰM TRONG giờ vận hành của kho
 * (operatingMsBetween), không phải tuổi thô của last_seen_at. Lý do đầy đủ
 * ở đầu src/lib/system/business-hours.ts — tóm tắt: kho tắt máy ban đêm,
 * đo thô thì 9 giờ sáng thứ Hai nào cũng crit.
 */
export async function checkAgentHeartbeat(admin: Admin, now: Date): Promise<SystemCheck> {
  const key = CHECK_KEYS.agentHeartbeat;
  const scope = await loadMonitoringScope(admin);

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
    .select("code, last_seen_at, organization_id")
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
    };
  }

  const inWindow: Array<{ agent: AgentRow; hours: OperatingHours | null }> = [];
  const outside: AgentRow[] = [];
  for (const agent of agents) {
    const hours = scope.hoursByOrg.get(agent.organization_id) ?? null;
    if (hours && !isWithinOperatingHours(now, hours)) {
      outside.push(agent);
      continue;
    }
    inWindow.push({ agent, hours });
  }

  if (inWindow.length === 0) {
    // Mọi kho đang ngoài ca. KHÔNG kết luận, KHÔNG cảnh báo — và cũng
    // không nói dối là "ok": lúc này hệ không chứng minh được điều gì.
    const windows = [
      ...new Set(
        outside.map((a) => {
          const h = scope.hoursByOrg.get(a.organization_id);
          return h ? describeOperatingHours(h) : "";
        }),
      ),
    ].filter(Boolean);
    return {
      key,
      status: "skipped",
      value: `${outside.length} kho ngoài giờ`,
      message:
        `Ngoài giờ vận hành của tất cả ${outside.length} agent đang theo dõi ` +
        `(${windows.join("; ")}) — không kiểm, không cảnh báo.` +
        invalidHoursNote(scope),
    };
  }

  const neverSeen = inWindow.filter((x) => !x.agent.last_seen_at);
  if (neverSeen.length > 0) {
    const names = neverSeen.map((x) => x.agent.code ?? "?").join(", ");
    return {
      key,
      status: "crit",
      value: `${neverSeen.length}/${inWindow.length} chưa từng kết nối`,
      message:
        `Agent chưa từng gửi heartbeat: ${names}. Đã tạo trong hệ nhưng chưa cài xong hoặc sai secret.` +
        invalidHoursNote(scope),
    };
  }

  const seen = inWindow
    .map((x) => {
      const lastSeen = new Date(x.agent.last_seen_at as string);
      const wallMs = Math.max(0, now.getTime() - lastSeen.getTime());
      return {
        code: x.agent.code ?? "?",
        // Không có giờ vận hành → theo dõi 24/7 → im-trong-giờ = tuổi thô.
        silentMs: x.hours ? operatingMsBetween(lastSeen, now, x.hours) : wallMs,
        wallMs,
      };
    })
    .sort((a, b) => b.silentMs - a.silentMs);

  const worst = seen[0];
  const silentAge = formatAge(worst.silentMs);
  const mins = worst.silentMs / 60_000;
  // Người trực cần thấy CẢ HAI con số: 45 phút trong giờ mà 15 tiếng đồng
  // hồ thật là ca "kho mở cửa muộn rồi chết", đọc một số dễ chẩn nhầm.
  const wallNote =
    worst.wallMs - worst.silentMs > 60_000
      ? ` (đồng hồ thật ${formatAge(worst.wallMs)}, phần ngoài giờ không tính)`
      : "";
  const skippedNote =
    outside.length > 0 ? ` ${outside.length} agent khác đang ngoài giờ, không tính.` : "";

  if (mins > CHECK_CONFIG.agentHeartbeat.critMinutes) {
    return {
      key,
      status: "crit",
      value: `${worst.code}: ${silentAge}`,
      message:
        `Agent "${worst.code}" im ${silentAge} trong giờ vận hành${wallNote}. ` +
        `Kho này đang KHÔNG ghi hình — gọi kiểm máy ngay.${skippedNote}` +
        invalidHoursNote(scope),
    };
  }
  if (mins > CHECK_CONFIG.agentHeartbeat.warnMinutes) {
    return {
      key,
      status: "warn",
      value: `${worst.code}: ${silentAge}`,
      message:
        `Agent "${worst.code}" im ${silentAge} trong giờ vận hành${wallNote} ` +
        `(ngưỡng ${CHECK_CONFIG.agentHeartbeat.warnMinutes} phút).${skippedNote}` +
        invalidHoursNote(scope),
    };
  }
  return {
    key,
    status: "ok",
    value: `${inWindow.length} agent, cũ nhất ${silentAge}`,
    // wallNote có mặt cả ở nhánh xanh, cố ý: sáng thứ Hai ô này ghi "im
    // lâu nhất 5 phút" trong khi máy kho vừa tắt 40 tiếng. Con số 5 phút
    // là con số ĐÚNG để kết luận, nhưng giấu con số 40 tiếng đi thì người
    // đọc sẽ tưởng kho chạy suốt đêm.
    message:
      `Tất cả ${inWindow.length} agent trong giờ vận hành còn kết nối, ` +
      `agent im lâu nhất ${silentAge}${wallNote}.${skippedNote}` +
      invalidHoursNote(scope),
  };
}

// ============================================================================
// 4. Camera probe
// ============================================================================

interface CameraRow {
  camera_code: string | null;
  last_probe_at: string | null;
  probe_consecutive_fails: number | null;
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
export async function checkCameraProbe(admin: Admin, now: Date): Promise<SystemCheck> {
  const key = CHECK_KEYS.cameraProbe;
  const scope = await loadMonitoringScope(admin);

  if (scope.orgIds.length === 0) {
    return {
      key,
      status: "unknown",
      unknownKind: "structural",
      value: "không có tổ chức nào theo dõi",
      message: "Không tổ chức nào bật monitoring_enabled — không có camera nào để kiểm.",
    };
  }

  // Ngoài giờ, agent không probe camera nào cả. Không lọc thì mục này trả
  // "0 camera lỗi" lúc 3 giờ sáng — ô xanh chứng minh bằng chỗ trống, đúng
  // kiểu xanh-giả mà file này có riêng một ràng buộc để cấm.
  const activeOrgIds = orgsInWindow(scope, now);
  if (activeOrgIds.length === 0) {
    return {
      key,
      status: "skipped",
      value: "ngoài giờ vận hành",
      message:
        "Mọi kho đang ngoài giờ vận hành nên agent không probe camera — " +
        "không có số liệu mới để kết luận, không cảnh báo." +
        invalidHoursNote(scope),
    };
  }

  const { data, error } = await admin
    .from("cameras")
    .select("camera_code, last_probe_at, probe_consecutive_fails")
    .eq("status", "active")
    .eq("last_probe_ok", false)
    .in("organization_id", activeOrgIds)
    .abortSignal(queryTimeout());
  if (error) throw new Error(error.message);

  const rows = (data as CameraRow[] | null) ?? [];
  if (rows.length === 0) {
    return {
      key,
      status: "ok",
      value: "0 camera lỗi",
      message: "Không có camera active nào đang ở trạng thái probe lỗi.",
    };
  }

  const staleMs = CHECK_CONFIG.cameraProbe.staleProbeMinutes * 60_000;
  const failingMs = CHECK_CONFIG.cameraProbe.failingMinutes * 60_000;
  const perFailMs = CHECK_CONFIG.cameraProbe.probeIntervalSeconds * 1_000;

  const stale: string[] = [];
  const failingLong: string[] = [];
  const failingShort: string[] = [];

  for (const r of rows) {
    const code = r.camera_code ?? "?";
    const probeAge = r.last_probe_at
      ? now.getTime() - new Date(r.last_probe_at).getTime()
      : Number.POSITIVE_INFINITY;
    if (probeAge > staleMs) {
      stale.push(code);
      continue;
    }
    const failingFor = (r.probe_consecutive_fails ?? 0) * perFailMs;
    if (failingFor >= failingMs) failingLong.push(code);
    else failingShort.push(code);
  }

  if (failingLong.length > 0) {
    return {
      key,
      status: "warn",
      value: `${failingLong.length} camera lỗi ≥ ${CHECK_CONFIG.cameraProbe.failingMinutes / 60} giờ`,
      message:
        `Camera không phản hồi RTSP quá ${CHECK_CONFIG.cameraProbe.failingMinutes / 60} giờ: ${failingLong.join(", ")}.` +
        (stale.length > 0 ? ` (Thêm ${stale.length} camera có số liệu probe cũ, không tính.)` : ""),
    };
  }
  if (failingShort.length > 0) {
    return {
      key,
      status: "ok",
      value: `${failingShort.length} camera vừa lỗi`,
      message: `Có ${failingShort.length} camera đang lỗi nhưng chưa quá ${CHECK_CONFIG.cameraProbe.failingMinutes / 60} giờ: ${failingShort.join(", ")}.`,
    };
  }
  return {
    key,
    status: "unknown",
    // Đứng yên chứ không phải hỏng: agent còn sống, chỉ là không probe
    // nhóm camera này nữa. Nếu agent chết thật thì agent_heartbeat mới là
    // mục nói đúng bản chất — không nhân đôi cùng một sự cố.
    unknownKind: "structural",
    value: `${stale.length} camera số liệu cũ`,
    message: `Có ${stale.length} camera đang ở trạng thái lỗi nhưng probe cũ hơn ${CHECK_CONFIG.cameraProbe.staleProbeMinutes} phút (agent không còn probe) — không kết luận được: ${stale.join(", ")}.`,
  };
}

// ============================================================================
// 5. Disk + RAM của VPS
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
// 6. Disk máy kho
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

/**
 * Chạy song song, mỗi mục tự bọc lỗi. Thứ tự trả về CỐ ĐỊNH theo đề bài
 * (egress → cron → agent → camera → VPS → disk kho) để trang hiển thị và
 * tin cảnh báo luôn đọc cùng một thứ tự.
 */
export async function runSystemChecks(deps: RunChecksDeps = {}): Promise<SystemCheck[]> {
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

  const [cron, agent, camera, vps] = await Promise.all([
    needAdmin(CHECK_KEYS.cronCleanup, (a) => checkCronCleanup(a, now)),
    needAdmin(CHECK_KEYS.agentHeartbeat, (a) => checkAgentHeartbeat(a, now)),
    needAdmin(CHECK_KEYS.cameraProbe, (a) => checkCameraProbe(a, now)),
    safeCheck(CHECK_KEYS.vps, () =>
      checkVpsResources({ now, os: deps.os, statfs: deps.statfs, path: deps.path }),
    ),
  ]);

  return [checkEgress(), cron, agent, camera, vps, checkWarehouseDisk()];
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
export function worstStatus(checks: SystemCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "crit")) return "crit";
  if (checks.some((c) => c.status === "warn")) return "warn";
  if (checks.some((c) => c.status === "unknown")) return "unknown";
  if (checks.some((c) => c.status === "ok")) return "ok";
  return "skipped";
}
