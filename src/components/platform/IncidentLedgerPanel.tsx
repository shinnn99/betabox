/**
 * Ô "Sổ sự cố" trên trang Tình trạng hệ thống — CHỈ ĐỌC (kế hoạch
 * VAN-HANH-NHIEU-KHO, đợt 3).
 *
 * Khác mục "Cần chú ý" ngay phía trên ở chỗ nào: "Cần chú ý" trả lời "LÚC NÀY
 * có gì hỏng" — chạy kiểm ngay lúc mở trang, không nhớ gì. Sổ trả lời "sự cố
 * này bắt đầu từ bao giờ, kéo dài bao lâu, lặp mấy lượt" — do con tự kiểm nền
 * ghi mỗi 15 phút. Thao tác Ghi nhận / Đã xử lý nằm ở trang Sự cố
 * (/platform/incidents). Con tự kiểm nền chưa chạy thì sổ RỖNG dù "Cần chú ý" có
 * mục — ô này nói rõ điều đó, không hiện "0 sự cố" cho người ta yên tâm nhầm.
 *
 * Không có hook — dựng và kiểm riêng được, như ConfigParamsPanel.
 */
import { AlertTriangle, BookOpen, XCircle } from "lucide-react";
import { ago, formatVn } from "@/lib/format/time-vn";

export interface LedgerIncident {
  id: string;
  check_key: string;
  severity: "crit" | "warn";
  peak_severity: "crit" | "warn";
  where_label: string;
  what_label: string;
  symptom: string;
  action: string;
  status: "open" | "acknowledged";
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  /**
   * Tên kho sở hữu sự cố. `null` = sự cố cấp hệ thống (cron, VPS) không thuộc
   * kho nào. Thiếu cột này thì hai kho có cùng `where_label` hiện ra y hệt
   * nhau — trang Sự cố có cột này từ đầu, sổ nhúng thì chưa.
   */
  organization_name?: string | null;
}

export type LedgerView =
  | { available: true; open: LedgerIncident[]; totalOpen: number }
  | { available: false; reason: string };

type PanelProps = Readonly<{
  ledger: LedgerView | undefined;
  /** Lượt tự kiểm nền gần nhất — thứ duy nhất ghi vào sổ. */
  lastBackgroundRun: string | null;
  now: number;
  checkLabels: Record<string, string>;
}>;

export default function IncidentLedgerPanel({ ledger, lastBackgroundRun, now, checkLabels }: PanelProps) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <BookOpen className="h-4 w-4 text-slate-500" />
        <h2 className="text-base font-semibold text-slate-800">Sổ sự cố</h2>
        {ledger?.available && (
          <span
            className={`h-6 px-2 rounded-lg text-[11px] font-semibold inline-flex items-center border ${
              ledger.totalOpen === 0
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            {ledger.totalOpen === 0 ? "không có sự cố mở" : `${ledger.totalOpen} đang mở`}
          </span>
        )}
        <a href="/platform/incidents" className="text-xs text-sky-700 underline">
          Mở trang Sự cố
        </a>
        <span className="text-xs text-slate-400">
          Ghi lần cuối: {lastBackgroundRun ? `${formatVn(lastBackgroundRun)} · ${ago(lastBackgroundRun, now)}` : "chưa bao giờ"}
        </span>
      </div>

      <LedgerBody ledger={ledger} lastBackgroundRun={lastBackgroundRun} now={now} checkLabels={checkLabels} />
    </section>
  );
}

/** Ba trạng thái của sổ, tách riêng cho dễ đọc: chưa có sổ / sổ rỗng / có sự cố. */
function LedgerBody({ ledger, lastBackgroundRun, now, checkLabels }: PanelProps) {
  if (!ledger?.available) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 flex items-start gap-2">
        <XCircle className="h-4 w-4 shrink-0 mt-0.5 text-slate-400" />
        <span>{ledger ? ledger.reason : "Máy chủ chưa trả phần sổ sự cố."}</span>
      </div>
    );
  }
  if (ledger.open.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        {/* Sổ rỗng có hai nghĩa rất khác nhau; nói rõ đang là nghĩa nào. */}
        {lastBackgroundRun
          ? "Không có sự cố nào đang mở."
          : "Sổ còn trống vì con tự kiểm nền chưa chạy lần nào — sổ chỉ được ghi từ đó, không phải từ trang này."}
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Kho</th>
              <th className="text-left px-4 py-2 font-medium">Ở đâu — cái gì</th>
              <th className="text-left px-4 py-2 font-medium">Bắt đầu</th>
              <th className="text-left px-4 py-2 font-medium">Lần cuối thấy</th>
              <th className="text-right px-4 py-2 font-medium">Số lượt</th>
              <th className="text-left px-4 py-2 font-medium">Triệu chứng · Cần làm</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ledger.open.map((i) => (
              <tr key={i.id} className={i.severity === "crit" ? "bg-red-50/40" : ""}>
                <td className="px-4 py-3 align-top text-xs">
                  {i.organization_name ? (
                    <span className="text-slate-700">{i.organization_name}</span>
                  ) : (
                    <span className="text-slate-400">Hệ thống</span>
                  )}
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="flex items-start gap-2">
                    <span
                      className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium border shrink-0 ${
                        i.severity === "crit"
                          ? "bg-red-50 text-red-700 border-red-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}
                    >
                      {i.severity === "crit" ? "Nghiêm trọng" : "Cảnh báo"}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium text-slate-800">
                        {i.where_label} — {i.what_label}
                      </p>
                      <p className="text-[11px] text-slate-400">{checkLabels[i.check_key] ?? i.check_key}</p>
                      {/* Đã từng nặng hơn bây giờ: đáng biết khi đọc lại. */}
                      {i.peak_severity === "crit" && i.severity !== "crit" && (
                        <p className="text-[11px] text-red-600">đã có lúc nghiêm trọng</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 align-top text-xs text-slate-600 whitespace-nowrap">
                  {formatVn(i.first_seen_at)}
                  <div className="text-slate-400">{ago(i.first_seen_at, now)}</div>
                </td>
                <td className="px-4 py-3 align-top text-xs text-slate-600 whitespace-nowrap">
                  {ago(i.last_seen_at, now)}
                </td>
                <td className="px-4 py-3 align-top text-right tabular-nums text-slate-700">
                  {i.occurrence_count}
                </td>
                <td className="px-4 py-3 align-top text-xs">
                  <p className="text-slate-600">{i.symptom}</p>
                  <p className="mt-1 text-slate-800 flex items-start gap-1">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px text-slate-400" />
                    <span>
                      <span className="text-slate-400">Cần làm: </span>
                      {i.action}
                    </span>
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ledger.totalOpen > ledger.open.length && (
        <p className="px-4 py-2 text-xs text-slate-400 border-t border-slate-100">
          Đang hiện {ledger.open.length}/{ledger.totalOpen} sự cố — nặng và mới nhất trước.
        </p>
      )}
    </div>
  );
}
