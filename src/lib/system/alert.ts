import "server-only";
import { buildLarkCardPayload, sendLarkWebhook } from "@/lib/lark/client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CHECK_CONFIG,
  buildDataSourceAlert,
  incidentUnknowns,
  needsAlert,
  type SystemCheck,
} from "@/lib/system/checks";
import { errorMessage } from "@/lib/system/job-log";

/**
 * Gửi cảnh báo hạ tầng lên Lark, có chống spam.
 *
 * Nguyên tắc: IM LẶNG LÀ BÌNH THƯỜNG. Tất cả ok → không gửi gì. Ai nhận
 * được tin của bot này nghĩa là có việc phải làm — nếu bot nói cả lúc khoẻ,
 * người ta sẽ tắt thông báo, và lần thật sẽ không ai đọc.
 *
 * Webhook TÁCH khỏi webhook nghiệp vụ của kho (LARK_INFRA_WEBHOOK_URL, nhóm
 * IT Betacom): egress/disk là chuyện nội bộ Betacom, khách không cần thấy.
 * Vì tách nên module này KHÔNG đọc LARK_CONFIG.enabled — kill switch đó
 * dành cho tin nghiệp vụ gửi cho khách; tắt tin khách không có nghĩa là tắt
 * cảnh báo hạ tầng của chính mình.
 */

export const SYSTEM_JOB_SYSTEM_CHECK = "system-check";

/** Không gửi lại cùng một mục ở cùng trạng thái trong 6 giờ. */
export const ALERT_DEDUPE_HOURS = 6;

export interface AlertedEntry {
  key: string;
  status: string;
}

interface SystemCheckJobDetail {
  alerted?: AlertedEntry[];
  /** Khoá đã gửi tin hồi phục ở lần chạy đó. Xem readRecentAlerts. */
  recovered?: string[];
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Đọc các lần gửi trong 6 giờ gần nhất từ chính `system_jobs`.
 *
 * Vì sao là DB chứ không phải biến RAM: đây là bài học đã trả giá — state
 * sống trong RAM của một tiến trình sẽ mất mỗi lần deploy/restart, và
 * chống-spam mất trí nhớ nghĩa là mỗi lần restart lại nã một loạt tin.
 */
export async function readRecentAlerts(
  admin: Admin,
  now: Date,
): Promise<Map<string, string>> {
  const sinceIso = new Date(
    now.getTime() - ALERT_DEDUPE_HOURS * 3_600_000,
  ).toISOString();

  const { data, error } = await admin
    .from("system_jobs")
    .select("detail, ran_at")
    .eq("job_name", SYSTEM_JOB_SYSTEM_CHECK)
    .gte("ran_at", sinceIso)
    .order("ran_at", { ascending: false })
    .abortSignal(AbortSignal.timeout(CHECK_CONFIG.queryTimeoutMs));
  if (error) throw new Error(error.message);

  // key → status đã gửi gần nhất trong cửa sổ.
  //
  // Duyệt từ MỚI đến CŨ (order ran_at desc ở trên), và khoá nào đã chốt thì
  // không ghi đè — nên bản ghi mới nhất của mỗi khoá thắng.
  //
  // `recovered` chốt khoá bằng một giá trị KHÔNG phải status thật: sau khi
  // đã báo hồi phục, mọi tin xấu cũ hơn của cùng khoá không còn hiệu lực
  // nén nữa. Nếu bỏ bước này thì kịch bản crit → ok → crit sẽ im ở lần crit
  // thứ hai, vì bản ghi crit cũ vẫn nằm trong cửa sổ 6 giờ — đúng loại lỗi
  // "tưởng có cảnh báo mà không có" mà cả module này sinh ra để chống.
  const lastAlerted = new Map<string, string>();
  const settled = new Set<string>();
  for (const row of (data ?? []) as Array<{ detail: SystemCheckJobDetail | null }>) {
    for (const key of row.detail?.recovered ?? []) {
      if (!settled.has(key)) settled.add(key);
    }
    for (const entry of row.detail?.alerted ?? []) {
      if (!settled.has(entry.key) && !lastAlerted.has(entry.key)) {
        lastAlerted.set(entry.key, entry.status);
      }
    }
  }
  return lastAlerted;
}

/**
 * Dựng danh sách ứng viên gửi từ kết quả một lần chạy.
 *
 * Ba nguồn, theo thứ tự nặng dần về nguyên nhân:
 *   1. Mục đo được và đang xấu (warn/crit) — luôn là ứng viên.
 *   2. Nhiều mục CÙNG mất nguồn do sự cố → gộp thành MỘT tin crit
 *      "nghi hạ tầng chung", và KHÔNG kèm từng mục lẻ nữa: ba tin cho một
 *      nguyên nhân là cách nhanh nhất khiến người ta tắt thông báo.
 *   3. Chỉ một mục mất nguồn → gửi đúng mục đó.
 *
 * Tin gộp đứng đầu vì nó giải thích những tin còn lại.
 */
export function collectAlertCandidates(checks: SystemCheck[]): SystemCheck[] {
  const bad = needsAlert(checks);
  const incidents = incidentUnknowns(checks);
  const aggregated = buildDataSourceAlert(incidents);
  if (aggregated) return [aggregated, ...bad];
  return [...incidents, ...bad];
}

/**
 * Lọc ra mục cần gửi.
 *
 * Gửi lại khi TRẠNG THÁI ĐỔI, kể cả còn trong 6 giờ: warn → crit là tin
 * mới và quan trọng hơn, nén nó lại là giấu đúng lúc cần biết. Chỉ nén khi
 * lặp lại y nguyên.
 *
 * Nhận thẳng danh sách ứng viên (đã qua collectAlertCandidates) nên hàm
 * này chỉ còn đúng một việc: nén trùng.
 */
export function selectAlertsToSend(
  candidates: SystemCheck[],
  lastAlerted: Map<string, string>,
): SystemCheck[] {
  return candidates.filter((c) => lastAlerted.get(c.key) !== c.status);
}

/** Trạng thái được coi là "đang có sự cố" khi xét hồi phục. */
const BAD_STATUSES = new Set(["crit", "warn", "unknown"]);

/**
 * Mục vừa TRỞ LẠI BÌNH THƯỜNG: lần gửi gần nhất là trạng thái xấu, lần
 * chạy này đã ok/skipped.
 *
 * VÌ SAO CẦN, dù nguyên tắc là "im lặng là bình thường": im lặng nói được
 * "không có gì mới", nhưng KHÔNG nói được "cái hỏng lúc nãy đã hết". Người
 * trực nhận tin crit lúc 9h mà tới 11h vẫn im thì không phân biệt được
 * "đã tự khỏi" với "vẫn hỏng, chỉ bị bộ chống-spam nén". Đó đúng là ca
 * 27/08: sự cố kéo 8 ngày, mọi lần chạy sau lần đầu đều bị nén.
 *
 * Đây là NGOẠI LỆ DUY NHẤT của luật im lặng, và nó hẹp có chủ đích: chỉ
 * gửi khi trước đó ĐÃ gửi tin xấu cho đúng khoá đó. Không có tin "mọi thứ
 * vẫn ổn" định kỳ.
 *
 * `skipped` cũng tính là hồi phục (kho vào ca nghỉ) — không còn mất bằng
 * chứng nữa, và giữ khoá ở trạng thái xấu sẽ chặn tin hồi phục thật sau đó.
 */
export function selectRecoveries(
  checks: SystemCheck[],
  lastAlerted: Map<string, string>,
): SystemCheck[] {
  return checks.filter((c) => {
    const prev = lastAlerted.get(c.key);
    if (prev === undefined || !BAD_STATUSES.has(prev)) return false;
    return c.status === "ok" || c.status === "skipped";
  });
}

const STATUS_LABEL: Record<string, string> = {
  crit: "🔴 NGHIÊM TRỌNG",
  warn: "🟡 Cảnh báo",
  unknown: "⚪ Không rõ",
  ok: "🟢 Bình thường",
  // Không bao giờ xuất hiện trong danh sách GỬI (needsAlert chỉ lấy
  // crit/warn) — có mặt ở đây để dòng tổng kết cuối tin đọc được.
  skipped: "🌙 Ngoài giờ",
};

/**
 * Tin hồi phục. Tách khỏi buildAlertPayload có chủ đích: tin xấu và tin
 * lành không được trộn vào một thẻ — người đọc lướt tiêu đề để quyết có
 * mở hay không, và một thẻ vừa báo hỏng vừa báo khỏi thì tiêu đề nào cũng sai.
 */
export function buildRecoveryPayload(
  recovered: SystemCheck[],
  dashboardUrl: string | null,
): object {
  const lines: string[] = [];
  for (const c of recovered) {
    lines.push(`**✅ Đã bình thường trở lại — ${c.key}**`);
    lines.push(`${c.value} · ${c.message}`);
    lines.push("");
  }
  return buildLarkCardPayload({
    title: "[Betabox] Hạ tầng đã hồi phục",
    bodyLines: lines,
    actionUrl: dashboardUrl,
    actionLabel: "Mở trang hệ thống",
  });
}

export function buildAlertPayload(
  toSend: SystemCheck[],
  allChecks: SystemCheck[],
  dashboardUrl: string | null,
): object {
  const hasCrit = toSend.some((c) => c.status === "crit");
  const lines: string[] = [];
  for (const c of toSend) {
    lines.push(`**${STATUS_LABEL[c.status] ?? c.status} — ${c.key}**`);
    lines.push(`${c.value} · ${c.message}`);
    lines.push("");
  }
  const okCount = allChecks.filter((c) => c.status === "ok").length;
  const unknownCount = allChecks.filter((c) => c.status === "unknown").length;
  const skippedCount = allChecks.filter((c) => c.status === "skipped").length;
  lines.push(
    `_Còn lại: ${okCount} mục bình thường, ${unknownCount} mục chưa đo được` +
      (skippedCount > 0 ? `, ${skippedCount} mục ngoài giờ vận hành` : "") +
      `._`,
  );

  return buildLarkCardPayload({
    title: hasCrit ? "[Betabox] Hạ tầng NGHIÊM TRỌNG" : "[Betabox] Cảnh báo hạ tầng",
    bodyLines: lines,
    actionUrl: dashboardUrl,
    actionLabel: "Mở trang hệ thống",
  });
}

export interface AlertOutcome {
  /** Mục đã gửi lần này (rỗng = không gửi gì). */
  alerted: AlertedEntry[];
  /** Khoá đã gửi tin "đã bình thường trở lại" lần này. */
  recovered: string[];
  /** null = không cần gửi; true/false = kết quả gọi Lark. */
  sent: boolean | null;
  error: string | null;
}

/**
 * Không throw. Lỗi gửi được trả về để caller ghi vào `system_jobs` —
 * cảnh báo gửi hụt phải để lại dấu vết, nếu không thì đúng cái lỗ "tưởng
 * có cảnh báo mà không có" lặp lại ở tầng trên.
 */
export async function sendSystemAlert(params: {
  admin: Admin;
  checks: SystemCheck[];
  now: Date;
  webhookUrl?: string | null;
  dashboardUrl?: string | null;
}): Promise<AlertOutcome> {
  const { admin, checks, now } = params;

  let lastAlerted: Map<string, string>;
  try {
    lastAlerted = await readRecentAlerts(admin, now);
  } catch (err) {
    // Không đọc được lịch sử → gửi (thà lặp một tin còn hơn nuốt cảnh báo
    // thật). Ghi lý do vào error để biết vì sao có thể trùng.
    lastAlerted = new Map();
    console.warn("[system-check] không đọc được lịch sử alert:", errorMessage(err));
  }

  const toSend = selectAlertsToSend(collectAlertCandidates(checks), lastAlerted);
  const recovered = selectRecoveries(checks, lastAlerted);
  if (toSend.length === 0 && recovered.length === 0) {
    return { alerted: [], recovered: [], sent: null, error: null };
  }

  const webhookUrl = params.webhookUrl ?? process.env.LARK_INFRA_WEBHOOK_URL ?? null;
  const alerted = toSend.map((c) => ({ key: c.key, status: c.status }));
  const recoveredKeys = recovered.map((c) => c.key);
  if (!webhookUrl) {
    return {
      alerted: [],
      recovered: [],
      sent: false,
      error: "LARK_INFRA_WEBHOOK_URL chưa cấu hình",
    };
  }

  const dashboardUrl = params.dashboardUrl ?? null;

  // Tin xấu TRƯỚC tin lành: nếu lượt này vừa có mục hỏng vừa có mục khỏi,
  // thứ cần đọc ngay là mục hỏng. Hai lần gọi webhook riêng, không gộp thẻ.
  let sent: boolean | null = null;
  let error: string | null = null;
  let alertOk = false;
  if (toSend.length > 0) {
    const res = await sendLarkWebhook(
      webhookUrl,
      buildAlertPayload(toSend, checks, dashboardUrl),
    );
    alertOk = res.ok;
    sent = res.ok;
    error = res.error;
  }

  // Tin hồi phục gửi kể cả khi tin xấu vừa hỏng: hai tin độc lập, nuốt tin
  // này vì tin kia lỗi là mất thông tin không lấy lại được.
  let recoveryOk = false;
  if (recovered.length > 0) {
    const res = await sendLarkWebhook(
      webhookUrl,
      buildRecoveryPayload(recovered, dashboardUrl),
    );
    recoveryOk = res.ok;
    if (sent === null) sent = res.ok;
    else sent = sent && res.ok;
    if (!res.ok && !error) error = res.error;
  }

  return {
    // Gửi hụt thì KHÔNG ghi là đã gửi — để lần chạy sau thử lại thay vì
    // bị chính bộ chống-spam nuốt mất.
    alerted: alertOk ? alerted : [],
    // Khoá đã báo hồi phục phải RỜI khỏi trí nhớ chống-spam, nếu không lần
    // hỏng sau (cùng key, cùng status cũ) sẽ bị nén và không ai được báo.
    // readRecentAlerts đọc ngược thời gian và lấy bản ghi mới nhất cho mỗi
    // key, nên một dòng `recovered` mới hơn là đủ để vô hiệu dòng cũ.
    recovered: recoveryOk ? recoveredKeys : [],
    sent,
    error,
  };
}
