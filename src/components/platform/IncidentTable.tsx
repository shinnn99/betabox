/**
 * Bảng của trang Sự cố — /platform/incidents (kế hoạch VAN-HANH-NHIEU-KHO,
 * đợt 4). Mọi kho, mỗi dòng một sự cố, kèm hai nút của người trực.
 *
 * Khác ô "Sổ sự cố" chỉ-đọc trên trang Tình trạng: ô đó là tóm tắt 20 dòng
 * nặng nhất; trang này là nơi LÀM VIỆC — lọc theo shop, xem cả sự cố đã
 * đóng, bấm Ghi nhận / Đã xử lý.
 *
 * Không giữ trạng thái — trang giữ và truyền xuống. Dựng và kiểm riêng được.
 */
import { AlertTriangle, CheckCircle2, Eye, Loader2 } from "lucide-react";
import { ago, formatVn, spanLabel } from "@/lib/format/time-vn";

export interface IncidentItem {
  id: string;
  check_key: string;
  organization_id: string | null;
  severity: "crit" | "warn";
  peak_severity: "crit" | "warn";
  where_label: string;
  what_label: string;
  symptom: string;
  action: string;
  status: "open" | "acknowledged" | "resolved";
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  acknowledged_at: string | null;
  acknowledged_by_email: string | null;
  resolved_at: string | null;
  resolved_reason: "auto_ok" | "out_of_scope" | "manual" | null;
}

export type IncidentActionKind = "acknowledge" | "resolve";

export const RESOLVED_REASON_LABEL: Record<NonNullable<IncidentItem["resolved_reason"]>, string> = {
  auto_ok: "tự khỏi — lượt tự kiểm thấy đã ổn",
  out_of_scope: "không còn theo dõi (đối tượng đã gỡ / lưu trữ)",
  manual: "người trực đóng tay",
};

/** "Kéo dài bao lâu" — từ lần đầu thấy tới lúc đóng, hoặc tới lần cuối thấy. */
export function durationLabel(i: Pick<IncidentItem, "first_seen_at" | "last_seen_at" | "resolved_at">): string {
  return spanLabel(i.first_seen_at, i.resolved_at ?? i.last_seen_at);
}

type TableProps = Readonly<{
  incidents: IncidentItem[];
  orgNames: Record<string, string>;
  checkLabels: Record<string, string>;
  now: number;
  /** id sự cố đang chờ máy chủ trả lời. */
  busyId: string | null;
  onAction: (incident: IncidentItem, action: IncidentActionKind) => void;
}>;

export default function IncidentTable({ incidents, orgNames, checkLabels, now, busyId, onAction }: TableProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Ở đâu — cái gì</th>
              <th className="text-left px-4 py-2 font-medium">Shop</th>
              <th className="text-left px-4 py-2 font-medium">Bắt đầu · kéo dài</th>
              <th className="text-right px-4 py-2 font-medium">Số lượt</th>
              <th className="text-left px-4 py-2 font-medium">Triệu chứng · Cần làm</th>
              <th className="text-left px-4 py-2 font-medium">Trạng thái</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {incidents.map((i) => (
              <IncidentRowView
                key={i.id}
                i={i}
                orgName={i.organization_id ? orgNames[i.organization_id] ?? "—" : "Hệ thống"}
                checkLabel={checkLabels[i.check_key] ?? i.check_key}
                now={now}
                busy={busyId === i.id}
                disabled={busyId !== null}
                onAction={onAction}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IncidentRowView({
  i,
  orgName,
  checkLabel,
  now,
  busy,
  disabled,
  onAction,
}: Readonly<{
  i: IncidentItem;
  orgName: string;
  checkLabel: string;
  now: number;
  busy: boolean;
  disabled: boolean;
  onAction: TableProps["onAction"];
}>) {
  const resolved = i.status === "resolved";
  let rowTone = "";
  if (resolved) rowTone = "opacity-70";
  else if (i.severity === "crit") rowTone = "bg-red-50/40";
  return (
    <tr className={rowTone}>
      <td className="px-4 py-3 align-top">
        <div className="flex items-start gap-2">
          <SeverityChip severity={i.severity} />
          <div className="min-w-0">
            <p className="font-medium text-slate-800">
              {i.where_label} — {i.what_label}
            </p>
            <p className="text-[11px] text-slate-400">{checkLabel}</p>
            {i.peak_severity === "crit" && i.severity !== "crit" && (
              <p className="text-[11px] text-red-600">đã có lúc nghiêm trọng</p>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 align-top text-xs text-slate-600">{orgName}</td>
      <td className="px-4 py-3 align-top text-xs text-slate-600 whitespace-nowrap">
        {formatVn(i.first_seen_at)}
        <div className="text-slate-400">
          {durationLabel(i)} · thấy lần cuối {ago(i.last_seen_at, now)}
        </div>
      </td>
      <td className="px-4 py-3 align-top text-right tabular-nums text-slate-700">{i.occurrence_count}</td>
      <td className="px-4 py-3 align-top text-xs max-w-md">
        <p className="text-slate-600">{i.symptom}</p>
        <p className="mt-1 text-slate-800 flex items-start gap-1">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px text-slate-400" />
          <span>
            <span className="text-slate-400">Cần làm: </span>
            {i.action}
          </span>
        </p>
      </td>
      <td className="px-4 py-3 align-top text-xs min-w-[11rem]">
        <StatusCell i={i} now={now} />
        {!resolved && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {i.status === "open" && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAction(i, "acknowledge")}
                className="h-7 px-2 rounded-lg border border-slate-200 bg-white text-slate-700 inline-flex items-center gap-1 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                {" "}Ghi nhận
              </button>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAction(i, "resolve")}
              className="h-7 px-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 inline-flex items-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {" "}Đã xử lý
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function SeverityChip({ severity }: Readonly<{ severity: IncidentItem["severity"] }>) {
  const crit = severity === "crit";
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium border shrink-0 ${
        crit ? "bg-red-50 text-red-700 border-red-200" : "bg-amber-50 text-amber-700 border-amber-200"
      }`}
    >
      {crit ? "Nghiêm trọng" : "Cảnh báo"}
    </span>
  );
}

function StatusCell({ i, now }: Readonly<{ i: IncidentItem; now: number }>) {
  if (i.status === "resolved") {
    return (
      <div>
        <p className="font-medium text-emerald-700">Đã đóng</p>
        {i.resolved_at && <p className="text-slate-400">{ago(i.resolved_at, now)}</p>}
        {i.resolved_reason && <p className="text-slate-500">{RESOLVED_REASON_LABEL[i.resolved_reason]}</p>}
      </div>
    );
  }
  if (i.status === "acknowledged") {
    return (
      <div>
        <p className="font-medium text-sky-700">Đã ghi nhận</p>
        <p className="text-slate-500">
          {i.acknowledged_by_email ?? "—"}
          {i.acknowledged_at ? ` · ${ago(i.acknowledged_at, now)}` : ""}
        </p>
      </div>
    );
  }
  return <p className="font-medium text-slate-700">Chưa ai nhận</p>;
}
