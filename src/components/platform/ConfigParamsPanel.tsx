/**
 * Tab "Cấu hình" của trang chi tiết tổ chức trên platform — bảng
 * Thông số / Đặt / Thực dùng / Ghi chú.
 *
 * Tách khỏi `src/app/platform/orgs/[id]/page.tsx` ngày 26/09/2026 để dựng
 * và kiểm riêng được: Next.js không cho file trang xuất thêm thành phần nào
 * ngoài trang, nên để lọt trong đó thì không có cách nào kiểm nó chạy.
 *
 * Không có hook — dùng được ở cả client lẫn server.
 */
import { AlertTriangle } from "lucide-react";
import type { EffectiveParam } from "@/lib/config/effective";

export interface ConfigParamsData {
  webhooks_configured: number;
  /** Bảng "Đặt / Thực dùng" — xem src/lib/config/effective.ts. */
  params: {
    org: EffectiveParam[];
    warehouses: Array<{
      id: string;
      code: string | null;
      name: string | null;
      params: EffectiveParam[];
    }>;
  };
}

export default function ConfigParamsPanel({ config }: { config: ConfigParamsData }) {
  const { org, warehouses } = config.params;
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-700 flex-1">Cấu hình chi tiết</h2>
          {(Object.keys(SOURCE_STYLE) as ParamSource[]).map((s) => (
            <span key={s} className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium border ${SOURCE_STYLE[s].chip}`}>
              {SOURCE_STYLE[s].label}
            </span>
          ))}
        </div>
        {/* Hai cột Đặt / Thực dùng là cả lý do tồn tại của tab này: trước
            26/09/2026 giao diện chỉ hiện con số đã đặt, và người đọc tưởng
            đó là con số đang chạy. Kho Betacom Demo đặt 600s mà hệ thống
            chạy 180s — không có chỗ nào cho thấy điều đó. */}
        <p className="text-sm text-slate-500">
          <span className="font-medium text-slate-700">Đặt</span> là số đang lưu.{" "}
          <span className="font-medium text-slate-700">Thực dùng</span> là số hệ thống thật sự chạy — lấy
          từ đúng hàm mà máy cắt clip và máy kho đang gọi, không tính lại. Hai cột lệch nhau thì dòng đó
          có tô màu và ghi lý do.
        </p>
        <p className="text-xs text-slate-400">
          Muốn sửa: mở trang <a href="/platform/config" className="text-sky-700 underline">Cấu hình các kho</a>{" "}
          — sửa thẳng, không cần đóng giả, nhật ký ghi tên bạn. Webhook Lark:{" "}
          {config.webhooks_configured > 0 ? `${config.webhooks_configured} kho đã bật` : "chưa cấu hình"}.
        </p>
      </div>

      <ParamTable title="Tổ chức" params={org} />

      {warehouses.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 text-sm text-slate-500 text-center">
          Tổ chức chưa có kho nào đang hoạt động.
        </div>
      ) : (
        warehouses.map((w) => (
          <ParamTable
            key={w.id}
            title={`Kho ${w.code ?? "—"}${w.name ? ` · ${w.name}` : ""}`}
            params={w.params}
          />
        ))
      )}
    </div>
  );
}

type ParamSource = EffectiveParam["source"];

const SOURCE_STYLE: Record<ParamSource, { label: string; chip: string; row: string }> = {
  set: {
    label: "Đặt",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    row: "",
  },
  default: {
    label: "Mặc định",
    chip: "bg-slate-100 text-slate-600 border-slate-200",
    row: "",
  },
  clamped: {
    label: "Bị kẹp",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    row: "bg-amber-50/40",
  },
  disabled: {
    label: "Không chạy",
    chip: "bg-red-50 text-red-700 border-red-200",
    row: "bg-red-50/40",
  },
};

function formatParamValue(v: number | null, unit: EffectiveParam["unit"]): string {
  if (v === null) return "—";
  return unit === "giây" ? `${v}s` : `${v} ngày`;
}

function ParamTable({ title, params }: { title: string; params: EffectiveParam[] }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Thông số</th>
              <th className="text-right px-4 py-2 font-medium">Đặt</th>
              <th className="text-right px-4 py-2 font-medium">Thực dùng</th>
              <th className="text-left px-4 py-2 font-medium">Ghi chú</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {params.map((p) => {
              const style = SOURCE_STYLE[p.source];
              return (
                <tr key={p.key} className={style.row}>
                  <td className="px-4 py-3 text-slate-700">{p.label}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                    {formatParamValue(p.set, p.unit)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-slate-800">
                    {p.effective === null ? "không chạy" : formatParamValue(p.effective, p.unit)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <span className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium border shrink-0 ${style.chip}`}>
                        {style.label}
                      </span>
                      <div className="min-w-0 space-y-1">
                        {p.reason && <p className="text-xs text-slate-600">{p.reason}</p>}
                        {/* Hệ quả tách riêng khỏi lý do: con số tự nó không
                            sai, nhưng phía sau có chuyện người đặt cần biết —
                            ví dụ clip kiện hoàn bị cụt. */}
                        {p.consequence && (
                          <p className="text-xs text-amber-700 flex items-start gap-1">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                            <span>{p.consequence}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
