"use client";

/**
 * Ô "Mẫu cấu hình nền tảng" trên trang /platform/config (kế hoạch
 * VAN-HANH-NHIEU-KHO, đợt 6).
 *
 * Hai việc, hai nút, cố ý tách:
 *   - Sửa mẫu: chỉ đổi giá trị CHÉP cho tổ chức / kho TẠO SAU này. Riêng trần
 *     clip có hiệu lực ngay cho cả nền tảng.
 *   - Điền vào ô trống: áp mẫu cho tổ chức ĐANG CÓ, chỉ những ô đang trống.
 *     Luôn xem trước rồi mới ghi.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, FileStack, Loader2, Pencil, X } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import type { PlatformTemplate, TemplateKey } from "@/lib/config/template";

interface TemplateResponse {
  template: PlatformTemplate;
  fromTable: boolean;
  reason: string | null;
  updated_at: string | null;
  bounds: Record<TemplateKey, { min: number; max: number }>;
  canEdit: boolean;
}

interface ApplyResult {
  orgId: string;
  name: string;
  applied: boolean;
  error?: string;
  plan: {
    org: Record<string, number>;
    warehouses: Array<{ code: string | null; timing: Record<string, number>; session_fallback_seconds?: number }>;
  };
}

export const TEMPLATE_ROWS: Array<{ key: TemplateKey; label: string; unit: string; note?: string }> = [
  { key: "retention_days", label: "Thời gian lưu video", unit: "ngày" },
  { key: "return_retention_days", label: "Thời gian lưu video hàng hoàn", unit: "ngày" },
  { key: "max_order_seconds", label: "Thời gian tối đa một đơn", unit: "s" },
  { key: "video_pre_seconds", label: "Video lấy trước lúc quét", unit: "s" },
  { key: "video_default_post_seconds", label: "Video lấy sau khi chưa có quét kế", unit: "s" },
  { key: "session_fallback_seconds", label: "Fallback session", unit: "s" },
  {
    key: "clip_max_seconds",
    label: "Trần clip bằng chứng (cả nền tảng)",
    unit: "s",
    note: "Có hiệu lực NGAY cho mọi kho: trần độ dài clip và trần tự dừng đơn đi. Tối đa 210s — dài hơn thì clip vượt 90 MiB, agent từ chối tải lên.",
  },
];

/** Tóm tắt kế hoạch điền của một tổ chức thành một dòng chữ. Hàm thuần. */
export function describePlan(plan: ApplyResult["plan"]): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(plan.org)) parts.push(`${k}=${v}`);
  for (const w of plan.warehouses) {
    const fields = [
      ...Object.entries(w.timing).map(([k, v]) => `${k}=${v}`),
      ...(w.session_fallback_seconds === undefined ? [] : [`session_fallback_seconds=${w.session_fallback_seconds}`]),
    ];
    parts.push(`kho ${w.code ?? "?"}: ${fields.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "không có ô trống";
}

export default function TemplatePanel({ orgIds }: Readonly<{ orgIds: string[] }>) {
  const [data, setData] = useState<TemplateResponse | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ key: TemplateKey; draft: string; saving: boolean } | null>(null);
  const [preview, setPreview] = useState<ApplyResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const apply = useCallback((r: { ok: true; data: TemplateResponse } | { ok: false; error: string }) => {
    if (r.ok) {
      setData(r.data);
      setError("");
    } else {
      setError(r.error);
    }
  }, []);

  useEffect(() => {
    let stale = false;
    void fetchTemplate().then((r) => {
      if (!stale) apply(r);
    });
    return () => {
      stale = true;
    };
  }, [apply]);

  const save = async () => {
    if (!editing) return;
    const value = Number(editing.draft);
    setEditing({ ...editing, saving: true });
    const res = await apiFetch("/api/platform/config/template", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [editing.key]: value }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setEditing(null);
      setNotice(
        json.audit?.ok === false
          ? `Đã lưu mẫu, nhưng KHÔNG ghi được nhật ký kiểm toán: ${json.audit.error}`
          : "Đã lưu mẫu — nhật ký nền tảng đã ghi tên bạn.",
      );
      apply(await fetchTemplate());
    } else {
      setEditing({ ...editing, saving: false });
      setNotice(json.message ?? json.error ?? "Không lưu được.");
    }
  };

  const runApply = async (dryRun: boolean) => {
    setBusy(true);
    setNotice("");
    const res = await apiFetch("/api/platform/config/template/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgIds, dryRun }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setNotice(json.message ?? json.error ?? "Không thực hiện được.");
      return;
    }
    const results = json.results as ApplyResult[];
    if (dryRun) {
      setPreview(results);
    } else {
      setPreview(null);
      const done = results.filter((r) => r.applied).length;
      const failed = results.filter((r) => r.error);
      setNotice(
        `Đã điền ô trống cho ${done} tổ chức.` +
          (failed.length ? ` Lỗi: ${failed.map((f) => `${f.name} (${f.error})`).join("; ")}` : "") +
          " Tải lại trang để thấy số mới.",
      );
    }
  };

  const needsFill = preview?.filter((r) => describePlan(r.plan) !== "không có ô trống") ?? [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
        <FileStack className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">Mẫu cấu hình nền tảng</h2>
        <span className="text-xs text-slate-400">chép vào tổ chức / kho lúc TẠO — sửa mẫu không đổi kho đang chạy</span>
        {data?.canEdit && (
          <button
            type="button"
            disabled={busy || orgIds.length === 0}
            onClick={() => void runApply(true)}
            className="ml-auto h-8 px-3 rounded-lg border border-slate-200 text-sm inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Xem trước: điền mẫu vào ô trống
          </button>
        )}
      </div>

      {error && <p className="p-4 text-sm text-red-600">{error}</p>}
      {data && !data.fromTable && <p className="px-4 pt-3 text-xs text-amber-700">{data.reason}</p>}
      {notice && <p className="px-4 pt-3 text-sm text-slate-700">{notice}</p>}

      {preview && (
        <div className="m-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm space-y-2">
          {needsFill.length === 0 ? (
            <p>Mọi tổ chức đang hiện đều đã đặt đủ — không có ô trống nào để điền.</p>
          ) : (
            <>
              <p className="font-medium text-slate-800">Sẽ điền (chỉ ô đang trống, không đụng ô đã đặt):</p>
              <ul className="list-disc pl-5 text-xs text-slate-700 space-y-1">
                {needsFill.map((r) => (
                  <li key={r.orgId}>
                    <span className="font-medium">{r.name}</span>: {describePlan(r.plan)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex gap-2">
            {needsFill.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void runApply(false)}
                className="h-8 px-3 rounded-lg bg-sky-600 text-white text-sm disabled:opacity-50"
              >
                Điền {needsFill.length} tổ chức
              </button>
            )}
            <button type="button" onClick={() => setPreview(null)} className="h-8 px-3 rounded-lg border border-slate-200 text-sm bg-white">
              Đóng
            </button>
          </div>
        </div>
      )}

      {data && (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {TEMPLATE_ROWS.map((row) => {
              const isEditing = editing?.key === row.key;
              const b = data.bounds[row.key];
              return (
                <tr key={row.key}>
                  <td className="px-4 py-2 text-slate-700 align-top">
                    {row.label}
                    {row.note && <p className="text-[11px] text-amber-700 mt-0.5 max-w-xl">{row.note}</p>}
                  </td>
                  <td className="px-4 py-2 align-top text-right whitespace-nowrap">
                    {isEditing ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          aria-label={row.label}
                          type="number"
                          autoFocus
                          value={editing.draft}
                          disabled={editing.saving}
                          onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                          className="w-20 h-7 px-1.5 rounded border border-slate-300 text-sm tabular-nums"
                        />
                        <button type="button" title="Lưu" onClick={() => void save()} className="h-7 w-7 grid place-items-center rounded bg-sky-600 text-white">
                          {editing.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        </button>
                        <button type="button" title="Huỷ" onClick={() => setEditing(null)} className="h-7 w-7 grid place-items-center rounded border border-slate-200 text-slate-500">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ) : (
                      <span className="font-semibold tabular-nums text-slate-800">
                        {data.template[row.key]}
                        {row.unit === "s" ? "s" : ` ${row.unit}`}
                      </span>
                    )}
                    <p className="text-[10px] text-slate-400">
                      {b.min}–{b.max}
                      {row.unit === "s" ? "s" : ` ${row.unit}`}
                    </p>
                  </td>
                  <td className="px-2 py-2 align-top w-8">
                    {data.canEdit && data.fromTable && !editing && (
                      <button
                        type="button"
                        title={`Sửa ${row.label}`}
                        onClick={() => setEditing({ key: row.key, draft: String(data.template[row.key]), saving: false })}
                        className="h-6 w-6 grid place-items-center rounded text-slate-400 hover:text-sky-700 hover:bg-sky-50"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

async function fetchTemplate(): Promise<{ ok: true; data: TemplateResponse } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/platform/config/template", { cache: "no-store" });
    const json = await res.json();
    if (res.ok) return { ok: true, data: json as TemplateResponse };
    return { ok: false, error: json.message ?? json.error ?? "Không tải được mẫu cấu hình." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Lỗi mạng." };
  }
}
