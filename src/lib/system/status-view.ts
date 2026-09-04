import "server-only";
import {
  CAMERA_BUCKET,
  CHECK_CONFIG,
  CHECK_KEYS,
  worstOfStatuses,
  type CheckEntity,
  type CheckStatus,
  type MonitoringScope,
  type SystemCheck,
} from "@/lib/system/checks";

/**
 * Biến kết quả 6 mục kiểm thành thứ người trực đọc được.
 *
 * VÌ SAO TÁCH KHỎI checks.ts: checks.ts trả lời "hệ có sao không" cho CON
 * CẢNH BÁO — mỗi mục một dòng, gộp về mức nặng nhất, vì tin Lark chỉ có
 * chừng đó chỗ. File này trả lời câu khác, cho NGƯỜI: "đang hỏng cái gì, ở
 * kho nào, tôi phải làm gì". Hai câu hỏi khác nhau thì hai cấu trúc khác
 * nhau; nhét chung sẽ có ngày ai đó sửa cho trang đẹp và làm hỏng tin cảnh
 * báo.
 *
 * Ràng buộc: file này THUẦN SUY DIỄN. Không truy vấn, không `new Date()`
 * ngầm, không dựng kết luận mới — mọi trạng thái đều bê nguyên từ
 * `checks`/`entities`. Nếu ở đây tính ra một kết luận mà tin Lark không có,
 * thì trang và cảnh báo bắt đầu nói hai chuyện khác nhau.
 */

/** Nhãn tiếng Việt của từng mục — dùng chung cho trang lẫn danh sách sự cố. */
export const CHECK_LABELS: Record<string, string> = {
  [CHECK_KEYS.egress]: "Egress Supabase",
  [CHECK_KEYS.cronCleanup]: "Cron dọn clip",
  [CHECK_KEYS.cronOrphanSegments]: "Cron dọn segment mồ côi",
  [CHECK_KEYS.agentHeartbeat]: "Kết nối agent kho",
  [CHECK_KEYS.cameraProbe]: "Camera",
  [CHECK_KEYS.recording]: "Ghi hình",
  [CHECK_KEYS.clipFailures]: "Clip đơn hàng",
  [CHECK_KEYS.vps]: "Ổ đĩa + RAM VPS",
  [CHECK_KEYS.storage]: "Dung lượng Storage",
  [CHECK_KEYS.warehouseDisk]: "Ổ đĩa máy kho",
};

/**
 * Câu trả lời cho "cái này nghĩa là gì với việc kinh doanh".
 *
 * Nhãn kỹ thuật ("Cron dọn clip") không nói được hậu quả, mà hậu quả mới là
 * thứ quyết định có dậy lúc 2 giờ sáng hay không.
 */
export const CHECK_MEANING: Record<string, string> = {
  [CHECK_KEYS.egress]: "Khách tải clip nhiều quá hạn mức thì Supabase khoá — cả hệ ngừng phục vụ.",
  [CHECK_KEYS.cronCleanup]: "Không dọn thì bucket phình, tiền lưu trữ tăng và sớm chạm hạn mức.",
  [CHECK_KEYS.cronOrphanSegments]:
    "Row segment mồ côi tích lại làm sai thống kê phủ sóng bằng chứng và ước lượng dung lượng.",
  [CHECK_KEYS.agentHeartbeat]: "Agent im nghĩa là kho đó đang KHÔNG ghi hình — mất bằng chứng vĩnh viễn.",
  [CHECK_KEYS.cameraProbe]: "Camera không phản hồi RTSP thì đơn quay qua camera đó không có clip.",
  [CHECK_KEYS.recording]: "Không có segment mới nghĩa là ffmpeg đã chết, dù agent và camera vẫn xanh.",
  [CHECK_KEYS.clipFailures]: "Mỗi clip lỗi là một đơn hàng không có bằng chứng khi khách hỏi.",
  [CHECK_KEYS.vps]: "Ổ đầy thì ffmpeg và build cùng chết; RAM cạn thì web đứng.",
  [CHECK_KEYS.storage]: "Bucket chạm hạn mức thì không upload được clip mới.",
  [CHECK_KEYS.warehouseDisk]: "Ổ máy kho đầy thì agent ngừng ghi, không có gì báo trước.",
};

/** Nơi phát sinh, cho mục KHÔNG gắn với kho cụ thể. */
const CHECK_SCOPE_LABEL: Record<string, string> = {
  [CHECK_KEYS.egress]: "Betacom · Supabase",
  [CHECK_KEYS.storage]: "Betacom · Supabase",
  [CHECK_KEYS.cronCleanup]: "Betacom · VPS",
  [CHECK_KEYS.cronOrphanSegments]: "Betacom · VPS",
  [CHECK_KEYS.vps]: "Betacom · VPS",
  [CHECK_KEYS.warehouseDisk]: "Máy kho",
  [CHECK_KEYS.agentHeartbeat]: "Toàn bộ kho",
  [CHECK_KEYS.cameraProbe]: "Toàn bộ kho",
  [CHECK_KEYS.recording]: "Toàn bộ kho",
  [CHECK_KEYS.clipFailures]: "Toàn bộ kho",
};

/** Việc cần làm cho mục không gắn với kho. Mục gắn kho tự mang `action`. */
const CHECK_ACTION: Record<string, string> = {
  [CHECK_KEYS.cronCleanup]:
    "SSH vào VPS: `systemctl status betabox-cleanup.timer`, rồi xem cột detail của bảng system_jobs.",
  [CHECK_KEYS.cronOrphanSegments]:
    "SSH vào VPS: `systemctl status betabox-orphan-segments.timer`, rồi xem cột detail của bảng system_jobs.",
  [CHECK_KEYS.vps]: "SSH vào VPS, dọn build/log cũ hoặc nâng dung lượng ổ.",
};

const INCIDENT_ACTION =
  "Mục này bình thường đo được — kiểm kết nối Supabase và biến môi trường trên VPS.";

/**
 * Việc cần làm khi một mục KHÔNG kết luận được vì phạm vi theo dõi rỗng
 * (chưa bật cờ, chưa cài agent, chưa khai camera). Không phải sự cố hạ
 * tầng, nhưng cũng tuyệt đối không phải "bình thường" — trang cũ để hai ca
 * này rơi vào ô xám chung với egress, và ô xám đó ai cũng lướt qua.
 */
const EMPTY_SCOPE_ACTION: Record<string, string> = {
  [CHECK_KEYS.agentHeartbeat]:
    "Kiểm cờ monitoring_enabled của tổ chức, và kho đã cài agent chưa.",
  [CHECK_KEYS.cameraProbe]:
    "Kiểm danh sách camera: chưa khai camera nào, hoặc tất cả đang ở status khác active.",
  [CHECK_KEYS.recording]: "Kiểm cờ monitoring_enabled, hoặc cách đo đã vượt trần số kho.",
  [CHECK_KEYS.clipFailures]: "Kiểm cờ monitoring_enabled của tổ chức.",
};

/**
 * Mục KHÔNG BAO GIỜ đo được ở phiên bản hiện tại.
 *
 * Nguồn sự thật là cờ `alertOnUnknown` trong CHECK_CONFIG — cùng một danh
 * sách mà con cảnh báo dùng để im lặng. Chép lại thành mảng thứ hai ở đây
 * là cách chắc chắn nhất để một ngày nào đó trang và cảnh báo nói hai
 * chuyện khác nhau về cùng một mục.
 */
function isNeverMeasurable(key: string): boolean {
  return CHECK_CONFIG.alertOnUnknown[key] === false;
}

// ============================================================================
// Tầng 2 — danh sách SỰ CỐ
// ============================================================================

/**
 * Một dòng sự cố = một việc phải làm, gắn với MỘT đối tượng cụ thể.
 *
 * Đây là thứ bản đầu thiếu: trang cũ dừng ở "AGENT_X im 45 phút" rồi hết —
 * không biết kho nào, không đi tiếp được, và ba kho cùng chết thì chỉ hiện
 * một cái tên.
 */
export interface SystemIssue {
  id: string;
  checkKey: string;
  status: "crit" | "warn" | "unknown";
  /** "Kho Đại Kim" / "Betacom · VPS" */
  where: string;
  /** Mã agent, mã camera, hoặc tên mục nếu không gắn đối tượng. */
  what: string;
  symptom: string;
  action: string;
  href: string | null;
}

const ISSUE_ORDER: Record<SystemIssue["status"], number> = { crit: 0, warn: 1, unknown: 2 };

function orgLabel(scope: MonitoringScope | null, orgId: string): string {
  return scope?.orgNameById.get(orgId) ?? orgId;
}

export function buildIssues(
  checks: SystemCheck[],
  scope: MonitoringScope | null,
): SystemIssue[] {
  const issues: SystemIssue[] = [];

  for (const check of checks) {
    if (check.entities && check.entities.length > 0) {
      for (const e of check.entities) {
        // "ok" và "skipped" không phải việc phải làm. Chúng vẫn có mặt ở
        // bảng theo kho — chỗ đó mới cần bức tranh đầy đủ.
        if (e.status !== "crit" && e.status !== "warn" && e.status !== "unknown") continue;
        issues.push({
          id: `${check.key}:${e.id}`,
          checkKey: check.key,
          status: e.status,
          where: orgLabel(scope, e.orgId),
          what: e.code,
          symptom: e.detail,
          action: e.action ?? INCIDENT_ACTION,
          href: `/platform/orgs/${e.orgId}`,
        });
      }
      continue;
    }

    // Mục không gắn đối tượng: cron, VPS — và cả agent/camera khi chính mục
    // đó hỏng nguồn (safeCheck nuốt lỗi trước khi kịp dựng entity).
    if (check.status === "crit" || check.status === "warn") {
      issues.push({
        id: check.key,
        checkKey: check.key,
        status: check.status,
        where: CHECK_SCOPE_LABEL[check.key] ?? "Betacom",
        what: CHECK_LABELS[check.key] ?? check.key,
        symptom: check.message,
        action: CHECK_ACTION[check.key] ?? INCIDENT_ACTION,
        href: null,
      });
      continue;
    }
    if (check.status !== "unknown") continue;
    // Egress và ổ máy kho dừng ở đây: "chưa có nguồn dữ liệu" là hạn chế đã
    // biết, không phải việc phải làm hôm nay — chúng xuống dòng chân trang.
    // Mọi unknown còn lại ĐỀU lên danh sách, gồm cả ca structural kiểu
    // "không org nào bật theo dõi": bản đầu để ca đó rơi vào ô xám chung
    // với egress, và ô xám đó ai cũng lướt qua.
    if (isNeverMeasurable(check.key)) continue;
    issues.push({
      id: check.key,
      checkKey: check.key,
      status: "unknown",
      where: CHECK_SCOPE_LABEL[check.key] ?? "Betacom",
      what: CHECK_LABELS[check.key] ?? check.key,
      symptom: check.message,
      action:
        check.unknownKind === "incident"
          ? INCIDENT_ACTION
          : (EMPTY_SCOPE_ACTION[check.key] ?? INCIDENT_ACTION),
      href: null,
    });
  }

  return issues.sort((a, b) => ISSUE_ORDER[a.status] - ISSUE_ORDER[b.status]);
}

// ============================================================================
// Tầng 3 — bảng theo kho
// ============================================================================

export interface OrgHealth {
  orgId: string;
  orgName: string;
  /** Tên kho active của org. Rỗng = org chưa khai kho nào. */
  warehouseNames: string[];
  /**
   * Mốc đơn hàng cuối được quét. null = kho chưa đóng gói đơn nào bao giờ.
   *
   * Thay cho cột "Giờ vận hành" của bản trước. Đây là thứ NGƯỜI TRỰC thật
   * sự cần biết để đọc mọi ô còn lại: agent im 3 tiếng mà đơn cuối cũng 3
   * tiếng trước thì kho đã nghỉ; đơn cuối 5 phút trước thì kho đang chạy và
   * agent đang chết.
   */
  lastScanAt: string | null;
  status: CheckStatus;
  agents: Array<{ id: string; code: string; status: CheckStatus; detail: string }>;
  cameras: { total: number; failingLong: number; failingShort: number; stale: number };
  /** null = mục ghi hình không kết luận được lượt này (ngoài giờ, quá trần đo). */
  recording: { status: CheckStatus; detail: string } | null;
  /** null = mục clip không kết luận được lượt này. */
  clipFailures: { status: CheckStatus; count: number; detail: string } | null;
}

function entitiesOf(checks: SystemCheck[], key: string): CheckEntity[] {
  return checks.find((c) => c.key === key)?.entities ?? [];
}

/**
 * Một dòng cho MỖI org đang bật theo dõi — kể cả org không có sự cố nào, và
 * kể cả org chưa cài agent.
 *
 * Đi từ `scope.orgIds` chứ không từ entity: org vắng mặt khỏi bảng sẽ bị
 * đọc thành "org này không tồn tại", trong khi sự thật có thể là "org này
 * chưa cài agent nào" — đúng thứ cần thấy nhất lúc onboard khách mới.
 *
 * KHÔNG nhận `now`, và đó là một tính chất chứ không phải thiếu sót: từ khi
 * bỏ khung giờ khai báo, không ô nào trong bảng này phụ thuộc đồng hồ. Mọi
 * kết luận đã nằm sẵn trong `status` của entity, do checks.ts tính bằng
 * cách đối chiếu hai mốc trong DB với nhau.
 */
export function buildOrgHealth(
  checks: SystemCheck[],
  scope: MonitoringScope | null,
): OrgHealth[] {
  if (!scope) return [];

  const agentsByOrg = new Map<string, CheckEntity[]>();
  for (const e of entitiesOf(checks, CHECK_KEYS.agentHeartbeat)) {
    const list = agentsByOrg.get(e.orgId) ?? [];
    list.push(e);
    agentsByOrg.set(e.orgId, list);
  }
  const camerasByOrg = new Map<string, CheckEntity[]>();
  for (const e of entitiesOf(checks, CHECK_KEYS.cameraProbe)) {
    const list = camerasByOrg.get(e.orgId) ?? [];
    list.push(e);
    camerasByOrg.set(e.orgId, list);
  }
  // Hai mục này sinh đúng một entity cho mỗi org, nên tra thẳng bằng Map.
  const recordingByOrg = new Map(entitiesOf(checks, CHECK_KEYS.recording).map((e) => [e.orgId, e]));
  const clipsByOrg = new Map(entitiesOf(checks, CHECK_KEYS.clipFailures).map((e) => [e.orgId, e]));

  return scope.orgIds.map((orgId) => {
    const agentEntities = agentsByOrg.get(orgId) ?? [];
    const cameraEntities = camerasByOrg.get(orgId) ?? [];
    const recordingEntity = recordingByOrg.get(orgId) ?? null;
    const clipEntity = clipsByOrg.get(orgId) ?? null;

    const cameras = {
      total: cameraEntities.length,
      failingLong: cameraEntities.filter((e) => e.bucket === CAMERA_BUCKET.failingLong).length,
      failingShort: cameraEntities.filter((e) => e.bucket === CAMERA_BUCKET.failingShort).length,
      stale: cameraEntities.filter((e) => e.bucket === CAMERA_BUCKET.stale).length,
    };

    const statuses = [
      ...agentEntities.map((e) => e.status),
      ...cameraEntities.map((e) => e.status),
      ...(recordingEntity ? [recordingEntity.status] : []),
      ...(clipEntity ? [clipEntity.status] : []),
    ];
    // Org chưa cài agent thì KHÔNG được xanh, dù mọi entity còn lại đều ok.
    //
    // Ca cụ thể đã cắn: `checkClipFailures` sinh entity "0 clip lỗi / ok"
    // cho MỌI org đang theo dõi, kể cả org chưa cài gì. Không chặn ở đây
    // thì một org vừa tạo, chưa có agent, chưa có camera sẽ hiện "Bình
    // thường" — ô xanh dựa trên chỗ trống, đúng thứ ràng buộc số 3 của
    // checks.ts cấm.
    if (agentEntities.length === 0) statuses.push("unknown");
    const status: CheckStatus = statuses.length === 0 ? "unknown" : worstOfStatuses(statuses);

    return {
      orgId,
      orgName: scope.orgNameById.get(orgId) ?? orgId,
      warehouseNames: scope.warehouseNamesByOrg.get(orgId) ?? [],
      lastScanAt: scope.lastScanByOrg.get(orgId) ?? null,
      status,
      agents: agentEntities.map((e) => ({
        id: e.id,
        code: e.code,
        status: e.status,
        detail: e.detail,
      })),
      cameras,
      recording: recordingEntity
        ? { status: recordingEntity.status, detail: recordingEntity.detail }
        : null,
      clipFailures: clipEntity
        ? {
            status: clipEntity.status,
            count: clipEntity.count ?? 0,
            detail: clipEntity.detail,
          }
        : null,
    };
  });
}

// ============================================================================
// Dãy ô số tổng
// ============================================================================

export interface HeroStat {
  key: string;
  label: string;
  /**
   * Tử số. **null = KHÔNG ĐO ĐƯỢC lượt này**, trang phải hiện "—" chứ không
   * phải 0.
   *
   * Đây là lỗi đã cắn thật ngày 13/08: lúc kho đóng cửa, ô "Agent online"
   * hiện `0 / 1` với dòng phụ màu xanh `0%`, và ô "Camera" hiện `0 / 0` kèm
   * chữ "Chưa khai camera nào" — trong khi kho có đủ 1 agent và 1 camera,
   * chỉ là ngoài ca nên không mục nào đo. Số 0 và chữ "chưa khai" đều là
   * kết luận, và cả hai đều sai. Cùng một loại nói dối với ô-xanh-dựa-trên-
   * chỗ-trống, chỉ ngược dấu.
   */
  value: number | null;
  /** Mẫu số; null = con số này không có mẫu (đếm sự cố, đếm điểm mù). */
  total: number | null;
  /** Câu dưới con số. Luôn có, kể cả khi mọi thứ bình thường. */
  hint: string;
  tone: CheckStatus;
}

/**
 * Ô "bao nhiêu cái đang bật trên tổng số", dùng chung cho agent và camera.
 *
 * HAI TRỤC TÁCH RIÊNG, và đây là điểm dễ sai nhất của cả trang:
 *
 *   * CON SỐ đếm thứ đang BẬT (`signalAgeMs` còn tươi). Ban đêm agent tắt
 *     thì `0 / 1` là sự thật — máy đúng là đang tắt.
 *   * MÀU lấy từ `status` của entity, tức "có mất bằng chứng không". Ban
 *     đêm không mất gì nên màu KHÔNG được đỏ.
 *
 * Bản trước gộp hai trục: đếm theo status rồi tô theo chính nó, nên ô hiện
 * `0 / 1` kèm `0%` màu xanh — vừa nói dối vừa trấn an. Gộp kiểu ngược lại
 * (đếm thứ đang bật rồi tô theo nó) thì mỗi tối lại thành báo động giả.
 */
function presenceStat(
  key: string,
  label: string,
  entities: CheckEntity[],
  /**
   * "Cái này đang hoạt động" — định nghĩa KHÁC NHAU giữa hai ô, cố ý:
   *   * agent: heartbeat còn tươi (máy đang bật).
   *   * camera: đang được probe VÀ probe trả về ok — camera đang được probe
   *     mà không phản hồi RTSP thì không phải "đang hoạt động".
   */
  isLive: (e: CheckEntity) => boolean,
  copy: { empty: string; allOff: string; healthy: string; unhealthy: (n: number) => string },
): HeroStat {
  if (entities.length === 0) {
    return { key, label, value: 0, total: 0, hint: copy.empty, tone: "unknown" };
  }
  const live = entities.filter(isLive).length;
  const tone = worstOfStatuses(entities.map((e) => e.status));
  const unhealthy = entities.filter((e) => e.status === "crit" || e.status === "warn").length;

  return {
    key,
    label,
    value: live,
    total: entities.length,
    hint:
      unhealthy > 0
        ? copy.unhealthy(unhealthy)
        : live === 0
          ? copy.allOff
          : live < entities.length
            ? `${entities.length - live} đang tắt, nhưng không mất bằng chứng nào`
            : copy.healthy,
    tone,
  };
}

/**
 * Sáu con số đầu trang.
 *
 * Mỗi con số PHẢI đếm từ `entities` hoặc từ danh sách sự cố — tuyệt đối
 * không có hằng số minh hoạ nào ở đây. Ô "12/14" nhìn đẹp hơn "1/1" rất
 * nhiều, và đó chính là lý do phải cấm: một con số không có nguồn thì
 * người trực vẫn tin nó, và tin nhầm.
 */
export function buildHeroStats(
  checks: SystemCheck[],
  scope: MonitoringScope | null,
  issues: SystemIssue[],
): HeroStat[] {
  const orgs = buildOrgHealthKeysOnly(checks, scope);
  const warehouseTotal = scope
    ? scope.orgIds.reduce((n, id) => n + (scope.warehouseNamesByOrg.get(id)?.length ?? 0), 0)
    : 0;
  const warehouseHealthy = scope
    ? scope.orgIds.reduce(
        (n, id) =>
          orgs.get(id) === "crit" || orgs.get(id) === "warn"
            ? n
            : n + (scope.warehouseNamesByOrg.get(id)?.length ?? 0),
        0,
      )
    : 0;

  const crit = issues.filter((i) => i.status === "crit").length;
  const warn = issues.filter((i) => i.status === "warn").length;
  const blind = unavailableChecks(checks).length;

  return [
    {
      key: "warehouses",
      label: "Kho theo dõi",
      value: warehouseHealthy,
      total: warehouseTotal,
      hint:
        warehouseTotal === 0
          ? "Chưa khai kho nào trong phạm vi theo dõi"
          : `${warehouseHealthy}/${warehouseTotal} kho không có sự cố`,
      tone: warehouseTotal === 0 ? "unknown" : warehouseHealthy < warehouseTotal ? "warn" : "ok",
    },
    presenceStat(
      "agents",
      "Agent online",
      entitiesOf(checks, CHECK_KEYS.agentHeartbeat),
      (e) =>
        e.signalAgeMs !== undefined &&
        e.signalAgeMs <= CHECK_CONFIG.agentHeartbeat.onlineWithinMinutes * 60_000,
      {
        empty: "Chưa cài agent nào trong phạm vi theo dõi",
        allOff: "Máy kho đang tắt — không đơn nào bị đóng gói sau đó",
        healthy: "Tất cả agent đều đang gửi heartbeat",
        unhealthy: (n) => `${n} kho mất bằng chứng vì agent im`,
      },
    ),
    presenceStat(
      "cameras",
      "Camera hoạt động",
      entitiesOf(checks, CHECK_KEYS.cameraProbe),
      // Nhóm `stale` (kho nghỉ) và nhóm lỗi đều KHÔNG tính là đang hoạt động.
      (e) => e.bucket === CAMERA_BUCKET.ok,
      {
        empty: "Chưa khai camera nào",
        allOff: "Không camera nào đang được probe — kho đang nghỉ",
        healthy: "Tất cả camera đều phản hồi RTSP",
        unhealthy: (n) => `${n} camera đang không phản hồi`,
      },
    ),
    {
      key: "incidents",
      label: "Sự cố đang mở",
      value: crit,
      total: null,
      hint: crit === 0 ? "Không có sự cố" : "Cần xử lý ngay",
      tone: crit === 0 ? "ok" : "crit",
    },
    {
      key: "warnings",
      label: "Cảnh báo",
      value: warn,
      total: null,
      hint: warn === 0 ? "Không có cảnh báo" : "Theo dõi thêm",
      tone: warn === 0 ? "ok" : "warn",
    },
    {
      key: "blindspots",
      label: "Điểm mù giám sát",
      value: blind,
      total: null,
      // Điểm mù KHÔNG bao giờ tô xanh, kể cả khi số nhỏ: xanh nghĩa là
      // "ổn rồi", mà mỗi điểm mù là một chỗ hệ không nhìn thấy gì.
      hint: blind === 0 ? "Đã phủ hết" : "Mục chưa có nguồn dữ liệu",
      tone: blind === 0 ? "ok" : "unknown",
    },
  ];
}

/** Trạng thái từng org, đủ dùng cho ô số tổng mà không dựng cả OrgHealth. */
function buildOrgHealthKeysOnly(
  checks: SystemCheck[],
  scope: MonitoringScope | null,
): Map<string, CheckStatus> {
  const out = new Map<string, CheckStatus>();
  if (!scope) return out;
  for (const orgId of scope.orgIds) {
    const statuses: CheckStatus[] = [];
    for (const key of [
      CHECK_KEYS.agentHeartbeat,
      CHECK_KEYS.cameraProbe,
      CHECK_KEYS.recording,
      CHECK_KEYS.clipFailures,
    ]) {
      for (const e of entitiesOf(checks, key)) {
        if (e.orgId === orgId) statuses.push(e.status);
      }
    }
    out.set(orgId, statuses.length === 0 ? "unknown" : worstOfStatuses(statuses));
  }
  return out;
}

// ============================================================================
// Dãy hạ tầng chung
// ============================================================================

export interface InfraTile {
  key: string;
  label: string;
  status: CheckStatus;
  /** Dòng số chính, vd "RAM 84.6%". */
  value: string;
  /** Dòng phụ, vd "Còn 2.4 GB / 15.7 GB". */
  detail: string;
}

/**
 * Hai tín hiệu chỉ trang này dùng — KHÔNG phải mục kiểm, cố ý.
 *
 *  * `selfCheckRuns24h`: con cảnh báo nền có chạy đủ nhịp không. Không thể
 *    là mục kiểm được: nếu nó chết thì chính nó không gửi được tin về việc
 *    nó chết. Chỉ có người mở trang mới phát hiện ra.
 *  * `supabaseLatencyMs`: độ trễ thật của một truy vấn trong lượt này. Cũng
 *    không cần thành mục kiểm — Supabase chết thì bốn mục dùng DB đã cùng
 *    rơi vào unknown-incident và bộ gộp bắn một tin "nghi hạ tầng chung".
 *    Thêm mục thứ năm cho cùng một nguyên nhân là nhân bản cảnh báo.
 */
export interface PageOnlySignals {
  selfCheckRuns24h: number | null;
  selfCheckExpected24h: number;
  supabaseLatencyMs: number | null;
}

/**
 * Mục không gắn với kho nào — nguồn cho dãy ô hạ tầng.
 *
 * `cron_orphan_segments` CỐ Ý không có ở đây dù nó cũng là mục Betacom·VPS:
 * dãy ô là chỗ liếc trong 2 giây, thêm ô thứ năm cho một job phụ làm loãng
 * ba ô quan trọng. Nó vẫn được kiểm mỗi 15 phút và vẫn bắn Lark khi warn
 * /crit — chỉ là không chiếm chỗ ở hàng đầu. Nó hiện trong danh sách sự cố
 * khi có chuyện, đó là lúc người trực cần thấy.
 */
export const SHARED_CHECK_KEYS: string[] = [CHECK_KEYS.cronCleanup, CHECK_KEYS.vps];

export function sharedChecks(checks: SystemCheck[]): SystemCheck[] {
  return checks.filter((c) => SHARED_CHECK_KEYS.includes(c.key));
}

/**
 * Dãy ô hạ tầng: hai tín hiệu chỉ-trang + hai mục kiểm không gắn kho.
 *
 * KHÔNG có ô "uptime %": hệ không ghi lịch sử uptime ở bất cứ đâu, nên con
 * số đó chỉ có thể là số bịa. Ô "Tự kiểm nền" thay vào chỗ đó và trả lời
 * đúng câu hỏi mà uptime định trả lời — hệ theo dõi có còn chạy không —
 * bằng dữ liệu có thật trong `system_jobs`.
 */
export function buildInfraTiles(
  checks: SystemCheck[],
  signals: PageOnlySignals,
): InfraTile[] {
  const tiles: InfraTile[] = [];

  const runs = signals.selfCheckRuns24h;
  const expected = signals.selfCheckExpected24h;
  tiles.push({
    key: "self_check",
    label: "Tự kiểm nền",
    status:
      runs === null
        ? "unknown"
        : runs === 0
          ? "crit"
          : runs < expected * 0.8
            ? "warn"
            : "ok",
    value: runs === null ? "chưa đọc được" : `${runs}/${expected} lượt`,
    detail:
      runs === null
        ? "Không đọc được sổ system_jobs."
        : runs === 0
          ? "KHÔNG lượt nào trong 24 giờ — systemd timer đã chết, hệ đang mù."
          : `24 giờ qua, systemd timer chạy mỗi 15 phút.`,
  });

  const ms = signals.supabaseLatencyMs;
  tiles.push({
    key: "supabase",
    label: "Supabase",
    // Ngưỡng thô có chủ đích: đây là độ trễ một truy vấn nhẹ từ VPS. Trên
    // 1 giây là đã đủ chậm để mọi route khác cảm thấy.
    status: ms === null ? "unknown" : ms > 1_000 ? "warn" : "ok",
    value: ms === null ? "không kết nối được" : `${ms} ms`,
    detail:
      ms === null
        ? "Truy vấn phạm vi theo dõi không chạy được lượt này."
        : "Độ trễ đo trong chính lượt kiểm này, không phải số trung bình.",
  });

  for (const c of sharedChecks(checks)) {
    tiles.push({
      key: c.key,
      label: CHECK_LABELS[c.key] ?? c.key,
      status: c.status,
      value: c.value,
      detail: c.message,
    });
  }
  return tiles;
}

/**
 * Mục VĨNH VIỄN không đo được ở phiên bản hiện tại (egress, ổ máy kho).
 *
 * Vì sao vẫn phải hiện, dù đã bỏ khỏi lưới chính: một trang toàn xanh mà
 * giấu luôn phần chưa theo dõi sẽ bị đọc thành "đã phủ hết". Ba tháng nữa
 * không ai nhớ egress đang KHÔNG có ai canh — và đó chính là cách sự cố
 * 103% xảy ra lần đầu.
 */
export function unavailableChecks(checks: SystemCheck[]): SystemCheck[] {
  return checks.filter((c) => c.status === "unknown" && isNeverMeasurable(c.key));
}
