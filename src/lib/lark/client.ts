import "server-only";
import { LARK_CONFIG } from "./config.ts";

// Kết quả gọi Lark. Không throw — orchestrator ghi cả success/fail vào
// notification_logs.
//
// responseStatus + responseBody: bằng chứng debug cho vế 2 verify production
// ("DB sent = số tin trong nhóm Lark"). Nếu DB nói sent mà Lark không nhận →
// đọc responseBody biết vì sao (invalid token, rate limit, format sai...).
export type LarkSendResult = {
  ok: boolean;
  error: string | null;         // null khi ok, string khi fail
  responseStatus: number | null; // null nếu network fail trước khi có response
  responseBody: string | null;   // raw body Lark trả về, cap 2000 chars
};

// Đường B (thận trọng): parse body có gắng, không đoán shape đầy đủ.
//
// Bằng chứng vì sao cần logic này:
//   BetacomEdu 3-4 tháng chạy với success=true GIẢ 100% (log pg_net status 202
//   ngay khi enqueue, không đợi Lark trả về). Không ai biết bao nhiêu tin thật
//   sự tới. Betacom scans TRÁNH hố này bằng cách check body.
//
// Rule:
//   1. HTTP không 2xx → fail (giữ nguyên hành vi cũ).
//   2. HTTP 2xx + body parse ra JSON có field `code`:
//        - code === 0 → sent (chuẩn Lark custom bot per docs BetacomEdu 0138).
//        - code !== 0 → failed, error = "lark_code_<n>: <msg>".
//   3. HTTP 2xx + body KHÔNG có `code` field / parse fail → fallback HTTP status
//      (không tệ hơn hành vi cũ, an toàn khi shape khác giả định).
function evaluateResponse(
  status: number,
  bodyText: string,
): { ok: boolean; error: string | null } {
  if (status < 200 || status >= 300) {
    return { ok: false, error: `http_${status}: ${bodyText.slice(0, 200)}` };
  }
  // Thử parse JSON. Không throw ra ngoài.
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Không phải JSON → fallback HTTP status.
    return { ok: true, error: null };
  }
  if (parsed && typeof parsed === "object" && "code" in parsed) {
    const code = (parsed as { code: unknown }).code;
    if (typeof code === "number") {
      if (code === 0) return { ok: true, error: null };
      const msg = "msg" in parsed && typeof (parsed as { msg: unknown }).msg === "string"
        ? (parsed as { msg: string }).msg
        : "unknown";
      return {
        ok: false,
        error: `lark_code_${code}: ${msg.slice(0, 200)}`,
      };
    }
  }
  // Không có `code` field hoặc code không phải số → fallback HTTP status.
  return { ok: true, error: null };
}

// (A) Payload interactive card thay text — bằng chứng cứng từ BetacomEdu
// (send-lark-notification/index.ts + migration 0138). Card có button URL →
// quản lý bấm 1 chạm tới dashboard trên điện thoại.
interface BuildCardInput {
  title: string;           // Header title (e.g. "[Kho A] Đơn quét trùng")
  bodyLines: string[];     // Các dòng nội dung (mã, thời gian, danh sách nén)
  actionUrl: string | null; // URL cho button. null → không có button.
  actionLabel: string;
}

export function buildLarkCardPayload(input: BuildCardInput): object {
  const elements: object[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: input.bodyLines.join("\n"),
      },
    },
  ];

  if (input.actionUrl) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: input.actionLabel },
          type: "primary",
          url: input.actionUrl,
        },
      ],
    });
  }

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: input.title },
        template: "orange", // orange = cảnh báo, khác blue của lịch học BetacomEdu
      },
      elements,
    },
  };
}

/**
 * Gửi payload tới Lark custom bot webhook.
 *
 * Payload đầy đủ do caller build (thường là buildLarkCardPayload).
 * Không throw — trả LarkSendResult với ok/error/responseStatus/responseBody.
 */
export async function sendLarkWebhook(
  webhookUrl: string,
  payload: object,
): Promise<LarkSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LARK_CONFIG.fetchTimeoutMs);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await res.text().catch(() => "");
    const bodyTrimmed = bodyText.slice(0, 2000);
    const verdict = evaluateResponse(res.status, bodyText);
    return {
      ok: verdict.ok,
      error: verdict.error,
      responseStatus: res.status,
      responseBody: bodyTrimmed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `fetch_error: ${msg.slice(0, 200)}`,
      responseStatus: null,
      responseBody: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
