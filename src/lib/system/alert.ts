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
  const lastAlerted = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ detail: SystemCheckJobDetail | null }>) {
    for (const entry of row.detail?.alerted ?? []) {
      if (!lastAlerted.has(entry.key)) lastAlerted.set(entry.key, entry.status);
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

const STATUS_LABEL: Record<string, string> = {
  crit: "🔴 NGHIÊM TRỌNG",
  warn: "🟡 Cảnh báo",
  unknown: "⚪ Không rõ",
  ok: "🟢 Bình thường",
};

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
  lines.push(`_Còn lại: ${okCount} mục bình thường, ${unknownCount} mục chưa đo được._`);

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
  if (toSend.length === 0) return { alerted: [], sent: null, error: null };

  const webhookUrl = params.webhookUrl ?? process.env.LARK_INFRA_WEBHOOK_URL ?? null;
  const alerted = toSend.map((c) => ({ key: c.key, status: c.status }));
  if (!webhookUrl) {
    return {
      alerted: [],
      sent: false,
      error: "LARK_INFRA_WEBHOOK_URL chưa cấu hình",
    };
  }

  const payload = buildAlertPayload(toSend, checks, params.dashboardUrl ?? null);
  const res = await sendLarkWebhook(webhookUrl, payload);
  return {
    // Gửi hụt thì KHÔNG ghi là đã gửi — để lần chạy sau thử lại thay vì
    // bị chính bộ chống-spam nuốt mất.
    alerted: res.ok ? alerted : [],
    sent: res.ok,
    error: res.error,
  };
}
