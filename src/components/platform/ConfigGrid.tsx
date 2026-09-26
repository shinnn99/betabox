/**
 * Lưới cấu hình toàn hệ thống — trang /platform/config (kế hoạch
 * VAN-HANH-NHIEU-KHO, đợt 4).
 *
 * Mỗi ô là MỘT thông số của MỘT tổ chức / kho: số to là "Thực dùng", màu là
 * nguồn (đặt / mặc định / bị kẹp / không chạy), số nhỏ là "Đặt" khi hai số
 * khác nhau. Nhìn một màn hình là thấy ngay org nào đang chạy mặc định — yêu
 * cầu "quản lý cấu hình dễ hơn" ở phần 6.2 của kế hoạch.
 *
 * Không giữ trạng thái: ô nào đang sửa, giá trị đang gõ, đang lưu — trang giữ
 * hết và truyền xuống. Dựng và kiểm riêng được như ConfigParamsPanel.
 */
import { AlertTriangle, Check, Loader2, Pencil, X } from "lucide-react";
import type { EffectiveParam } from "@/lib/config/effective";

export interface GridWarehouse {
  id: string;
  code: string | null;
  name: string | null;
  params: EffectiveParam[];
}

export interface GridOrg {
  id: string;
  name: string;
  status: string;
  params: EffectiveParam[];
  warehouses: GridWarehouse[];
}

/** Ô nào sửa được — đúng các ô route tenant cũng sửa được. */
export const EDITABLE_ORG_KEYS = ["retention_days", "return_retention_days"] as const;
export const EDITABLE_WAREHOUSE_KEYS = [
  "max_order_seconds",
  "video_pre_seconds",
  "video_default_post_seconds",
  "session_fallback_seconds",
] as const;

/** Khoảng nhận — hiện cạnh ô nhập. Khớp src/lib/config/validate.ts. */
export const EDIT_HINT: Record<string, string> = {
  retention_days: "7–365 ngày",
  return_retention_days: "7–365 ngày",
  max_order_seconds: "60–3600s (video vẫn kẹp ở 180s)",
  video_pre_seconds: "0–120s",
  video_default_post_seconds: "1–600s",
  session_fallback_seconds: "số giây > 0",
};

export interface EditTarget {
  kind: "org" | "warehouse";
  orgId: string;
  warehouseId: string | null;
  key: string;
}

export interface EditState {
  target: EditTarget;
  draft: string;
  saving: boolean;
  error: string | null;
}

type ParamSource = EffectiveParam["source"];

export const SOURCE_STYLE: Record<ParamSource, { label: string; cell: string; chip: string }> = {
  set: { label: "Đặt", cell: "", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  default: { label: "Mặc định", cell: "bg-slate-50", chip: "bg-slate-100 text-slate-600 border-slate-200" },
  clamped: { label: "Bị kẹp", cell: "bg-amber-50", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  disabled: { label: "Không chạy", cell: "bg-red-50", chip: "bg-red-50 text-red-700 border-red-200" },
};

export function formatValue(v: number | null, unit: EffectiveParam["unit"]): string {
  if (v === null) return "—";
  return unit === "giây" ? `${v}s` : `${v} ngày`;
}

const sameTarget = (a: EditTarget | undefined, b: EditTarget) =>
  !!a && a.kind === b.kind && a.orgId === b.orgId && a.warehouseId === b.warehouseId && a.key === b.key;

type CellHandlers = Readonly<{
  canEdit: boolean;
  editing: EditState | null;
  onStartEdit: (target: EditTarget, initial: string) => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}>;

export function ParamCell({
  param,
  target,
  editable,
  handlers,
}: Readonly<{ param: EffectiveParam | undefined; target: EditTarget; editable: boolean; handlers: CellHandlers }>) {
  if (!param) return <td className="px-3 py-2 text-xs text-slate-300">—</td>;
  const style = SOURCE_STYLE[param.source];
  const ed = handlers.editing;

  if (sameTarget(ed?.target, target) && ed) {
    return (
      <td className="px-3 py-2 align-top bg-white ring-2 ring-inset ring-sky-300">
        <div className="flex items-center gap-1">
          <input
            aria-label={param.label}
            type="number"
            autoFocus
            value={ed.draft}
            disabled={ed.saving}
            onChange={(e) => handlers.onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handlers.onSave();
              if (e.key === "Escape") handlers.onCancel();
            }}
            className="w-20 h-7 px-1.5 rounded border border-slate-300 text-sm tabular-nums"
          />
          <button
            type="button"
            title="Lưu"
            onClick={handlers.onSave}
            disabled={ed.saving}
            className="h-7 w-7 grid place-items-center rounded bg-sky-600 text-white disabled:opacity-50"
          >
            {ed.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            title="Huỷ"
            onClick={handlers.onCancel}
            disabled={ed.saving}
            className="h-7 w-7 grid place-items-center rounded border border-slate-200 text-slate-500"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1 text-[10px] text-slate-400">{EDIT_HINT[param.key]}</p>
        {ed.error && <p className="mt-1 text-[11px] text-red-600 max-w-[14rem]">{ed.error}</p>}
      </td>
    );
  }

  const differs = param.set !== param.effective;
  const note = [param.reason, param.consequence].filter(Boolean).join(" · ");
  return (
    <td className={`px-3 py-2 align-top ${style.cell}`} title={note || undefined}>
      <div className="flex items-start gap-1.5 group">
        <div className="min-w-0">
          <p className="text-sm font-semibold tabular-nums text-slate-800">
            {param.effective === null ? "không chạy" : formatValue(param.effective, param.unit)}
          </p>
          <p className="text-[10px] text-slate-500 whitespace-nowrap">
            {style.label}
            {differs && param.set !== null && <> · đặt {formatValue(param.set, param.unit)}</>}
          </p>
          {param.consequence && (
            <AlertTriangle className="mt-0.5 h-3 w-3 text-amber-600" aria-label={param.consequence} />
          )}
        </div>
        {editable && handlers.canEdit && !handlers.editing && (
          <button
            type="button"
            title={`Sửa ${param.label}`}
            onClick={() => handlers.onStartEdit(target, String(param.set ?? param.effective ?? ""))}
            className="ml-auto h-6 w-6 grid place-items-center rounded text-slate-400 hover:text-sky-700 hover:bg-sky-50"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </td>
  );
}

/** Tên cột lấy từ chính phép giải — không đặt tên lần thứ hai. */
function columnsOf(rows: EffectiveParam[][]): Array<{ key: string; label: string }> {
  const seen = new Map<string, string>();
  for (const params of rows) for (const p of params) if (!seen.has(p.key)) seen.set(p.key, p.label);
  return [...seen].map(([key, label]) => ({ key, label }));
}

export function OrgGrid({ orgs, handlers }: Readonly<{ orgs: GridOrg[]; handlers: CellHandlers }>) {
  const cols = columnsOf(orgs.map((o) => o.params));
  return (
    <GridFrame title="Tổ chức" count={orgs.length} empty="Không có tổ chức nào khớp bộ lọc.">
      {orgs.length > 0 && (
        <table className="w-full text-sm">
          <thead className="bg-slate-50/50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Tổ chức</th>
              {cols.map((c) => (
                <th key={c.key} className="text-left px-3 py-2 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {orgs.map((o) => (
              <tr key={o.id}>
                <td className="px-3 py-2 align-top">
                  <p className="font-medium text-slate-800">{o.name}</p>
                  {o.status !== "active" && <p className="text-[11px] text-slate-400">{o.status}</p>}
                </td>
                {cols.map((c) => (
                  <ParamCell
                    key={c.key}
                    param={o.params.find((p) => p.key === c.key)}
                    target={{ kind: "org", orgId: o.id, warehouseId: null, key: c.key }}
                    editable={(EDITABLE_ORG_KEYS as readonly string[]).includes(c.key)}
                    handlers={handlers}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </GridFrame>
  );
}

export function WarehouseGrid({
  rows,
  handlers,
}: Readonly<{ rows: Array<{ org: GridOrg; wh: GridWarehouse }>; handlers: CellHandlers }>) {
  const cols = columnsOf(rows.map((r) => r.wh.params));
  return (
    <GridFrame title="Kho đang hoạt động" count={rows.length} empty="Không có kho nào khớp bộ lọc.">
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="bg-slate-50/50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Kho</th>
              {cols.map((c) => (
                <th key={c.key} className="text-left px-3 py-2 font-medium min-w-[7rem]">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ org, wh }) => (
              <tr key={wh.id}>
                <td className="px-3 py-2 align-top">
                  <p className="font-medium text-slate-800">{wh.code ?? "—"}</p>
                  <p className="text-[11px] text-slate-400">{wh.name ? `${wh.name} · ` : ""}{org.name}</p>
                </td>
                {cols.map((c) => (
                  <ParamCell
                    key={c.key}
                    param={wh.params.find((p) => p.key === c.key)}
                    target={{ kind: "warehouse", orgId: org.id, warehouseId: wh.id, key: c.key }}
                    editable={(EDITABLE_WAREHOUSE_KEYS as readonly string[]).includes(c.key)}
                    handlers={handlers}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </GridFrame>
  );
}

function GridFrame({
  title,
  count,
  empty,
  children,
}: Readonly<{ title: string; count: number; empty: string; children: React.ReactNode }>) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <span className="text-xs text-slate-400">{count}</span>
      </div>
      {count === 0 ? (
        <p className="p-6 text-sm text-slate-500 text-center">{empty}</p>
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </section>
  );
}
