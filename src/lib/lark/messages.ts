// Pure: build message input cho Lark card theo event_type. Không throw,
// không I/O. Trả về shape cho buildLarkCardPayload trong client.ts.

export type LarkEventType =
  | "packing_issue_duplicated"
  | "packing_issue_no_active_session"
  | "packing_issue_unmapped_scanner"
  | "packing_issue_invalid_code";

export interface BuildMessageInput {
  eventType: LarkEventType;
  warehouseName: string;
  waybillCode: string | null;
  scannedAtIso: string;
  // Danh sách waybill CÙNG (warehouse, event_type) bị nén trong cửa sổ TRƯỚC.
  suppressedWaybillsInPreviousWindow: string[];
  // Deep-link về dashboard. Null = env chưa cấu hình → card không có button.
  dashboardUrl: string | null;
}

// Output cho client.buildLarkCardPayload
export interface CardMessageParts {
  title: string;
  bodyLines: string[];
  actionUrl: string | null;
  actionLabel: string;
  // Plain text fallback — dùng khi test/log/debug muốn đọc content nhanh
  // không cần render card.
  plainText: string;
}

const EVENT_LABEL: Record<LarkEventType, string> = {
  packing_issue_duplicated: "Đơn quét trùng",
  packing_issue_no_active_session: "Quét khi không có ca mở",
  packing_issue_unmapped_scanner: "Máy quét chưa gán bàn",
  packing_issue_invalid_code: "Mã quét không hợp lệ",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Cap số mã liệt kê để card không phình vô hạn khi camera rớt 100 lần.
const MAX_LISTED_WAYBILLS = 10;

export function buildMessageParts(input: BuildMessageInput): CardMessageParts {
  const label = EVENT_LABEL[input.eventType];
  const wb = input.waybillCode ?? "(không có mã)";
  const time = formatTime(input.scannedAtIso);

  const title = `[${input.warehouseName}] ${label}`;

  // Body dùng lark_md format cho card interactive (** ** để bold).
  const bodyLines: string[] = [
    `**Mã:** ${wb}`,
    `**Lúc:** ${time}`,
  ];

  const suppressed = input.suppressedWaybillsInPreviousWindow;
  if (suppressed.length > 0) {
    const shown = suppressed.slice(0, MAX_LISTED_WAYBILLS);
    const listStr = shown.map((c) => c || "(rỗng)").join(", ");
    if (suppressed.length > MAX_LISTED_WAYBILLS) {
      const rest = suppressed.length - MAX_LISTED_WAYBILLS;
      bodyLines.push(`**5 phút qua còn ${suppressed.length} đơn cùng loại:** ${listStr}, +${rest} khác.`);
    } else {
      bodyLines.push(`**5 phút qua còn ${suppressed.length} đơn cùng loại:** ${listStr}.`);
    }
  }

  // Plain text version — dùng cho verify script assert dễ đọc.
  const plainText = [title, ...bodyLines.map((l) => l.replace(/\*\*/g, ""))].join("\n");

  return {
    title,
    bodyLines,
    actionUrl: input.dashboardUrl,
    actionLabel: "🔍 Xem trên dashboard",
    plainText,
  };
}
