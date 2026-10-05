"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import TemplatePanel from "@/components/platform/TemplatePanel";
import { apiFetch } from "@/lib/api-fetch";
import {
  OrgGrid,
  SOURCE_STYLE,
  WarehouseGrid,
  type EditState,
  type EditTarget,
  type GridOrg,
} from "@/components/platform/ConfigGrid";
import { paramsNeedAttention as needsAttention, type EffectiveParam } from "@/lib/config/effective";

/**
 * Cấu hình toàn hệ thống (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4).
 *
 * Trước trang này, muốn biết hay sửa cấu hình một kho phải "Bắt đầu hỗ trợ"
 * (đóng giả vào tổ chức) — mỗi lần một tổ chức, và nhật ký ghi thành người
 * trong tổ chức tự sửa. Ở đây: mọi tổ chức một màn hình; sửa thẳng; nhật ký
 * nền tảng ghi đúng tên admin kèm giá trị trước / sau.
 */

interface ConfigResponse {
  canEdit: boolean;
  orgs: GridOrg[];
}

type Toast = { tone: "ok" | "warn"; text: string } | null;

type FetchResult = { ok: true; data: ConfigResponse } | { ok: false; error: string };

async function fetchConfig(): Promise<FetchResult> {
  try {
    const res = await fetch("/api/platform/config", { cache: "no-store" });
    const json = await res.json();
    if (res.ok) return { ok: true, data: json as ConfigResponse };
    return { ok: false, error: json.message ?? json.error ?? "Không tải được cấu hình." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Lỗi mạng." };
  }
}

const RETENTION_KEYS = new Set(["retention_days", "return_retention_days"]);

export default function PlatformConfigPage() {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const apply = useCallback((r: FetchResult) => {
    if (r.ok) {
      setData(r.data);
      setError("");
    } else {
      setError(r.error);
    }
    setLoading(false);
  }, []);

  // setState chỉ trong callback — không gọi thẳng trong thân effect.
  useEffect(() => {
    let stale = false;
    void fetchConfig().then((r) => {
      if (!stale) apply(r);
    });
    return () => {
      stale = true;
    };
  }, [apply]);

  const q = query.trim().toLowerCase();
  const orgs = useMemo(() => {
    return (data?.orgs ?? []).filter((o) => {
      if (onlyAttention && !needsAttention(o.params)) return false;
      return !q || o.name.toLowerCase().includes(q);
    });
  }, [data, q, onlyAttention]);

  const whRows = useMemo(() => {
    return (data?.orgs ?? []).flatMap((org) =>
      org.warehouses
        .filter((wh) => {
          if (onlyAttention && !needsAttention(wh.params)) return false;
          if (!q) return true;
          return [org.name, wh.code ?? "", wh.name ?? ""].some((s) => s.toLowerCase().includes(q));
        })
        .map((wh) => ({ org, wh })),
    );
  }, [data, q, onlyAttention]);

  const findParam = useCallback(
    (t: EditTarget): EffectiveParam | undefined => {
      const org = data?.orgs.find((o) => o.id === t.orgId);
      const params = t.kind === "org" ? org?.params : org?.warehouses.find((w) => w.id === t.warehouseId)?.params;
      return params?.find((p) => p.key === t.key);
    },
    [data],
  );

  const applyParams = useCallback((target: EditTarget, params: EffectiveParam[]) => {
    setData((prev) => {
      if (!prev) return prev;
      const orgs = prev.orgs.map((o) => {
        if (o.id !== target.orgId) return o;
        if (target.kind === "org") return { ...o, params };
        return { ...o, warehouses: o.warehouses.map((w) => (w.id === target.warehouseId ? { ...w, params } : w)) };
      });
      return { ...prev, orgs };
    });
  }, []);

  const save = useCallback(async () => {
    if (!editing) return;
    const { target, draft } = editing;
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(value)) {
      setEditing({ ...editing, error: "Nhập một con số." });
      return;
    }
    const current = findParam(target);
    // Hạ hạn lưu = video cũ hơn mốc mới bị xoá ở lượt dọn tới, không lấy lại được.
    if (RETENTION_KEYS.has(target.key) && current?.effective != null && value < current.effective) {
      const ok = globalThis.confirm(
        `Hạ "${current.label}" từ ${current.effective} xuống ${value} ngày.\n\n` +
          `Video cũ hơn ${value} ngày ở máy kho sẽ bị xoá ở lượt dọn tới và KHÔNG lấy lại được. Tiếp tục?`,
      );
      if (!ok) return;
    }

    setEditing({ ...editing, saving: true, error: null });
    const url =
      target.kind === "org"
        ? `/api/platform/orgs/${target.orgId}/config`
        : `/api/platform/orgs/${target.orgId}/warehouses/${target.warehouseId}/config`;
    const body =
      target.kind === "org" || target.key === "session_fallback_seconds"
        ? { [target.key]: value }
        : { packing_timing_config: { [target.key]: value } };
    try {
      const res = await apiFetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setEditing({ ...editing, saving: false, error: json.message ?? json.error ?? "Không lưu được." });
        return;
      }
      const params = json.params as EffectiveParam[];
      applyParams(target, params);
      setEditing(null);
      const saved = params.find((p) => p.key === target.key);
      // Route kẹp giá trị ngoài khoảng (cùng luật với tenant) — nói ra, đừng
      // để người sửa tưởng số mình gõ đã được lưu nguyên.
      const clampedNote = saved && saved.set !== value ? ` (đã kẹp về ${saved.set})` : "";
      setToast(
        json.audit?.ok === false
          ? { tone: "warn", text: `Đã lưu${clampedNote}, nhưng KHÔNG ghi được nhật ký kiểm toán: ${json.audit.error}` }
          : { tone: "ok", text: `Đã lưu ${saved?.label ?? target.key}${clampedNote} — nhật ký nền tảng đã ghi tên bạn.` },
      );
    } catch (err) {
      setEditing({ ...editing, saving: false, error: err instanceof Error ? err.message : "Lỗi mạng." });
    }
  }, [editing, findParam, applyParams]);

  const handlers = {
    canEdit: data?.canEdit ?? false,
    editing,
    onStartEdit: (target: EditTarget, initial: string) => {
      setToast(null);
      setEditing({ target, draft: initial, saving: false, error: null });
    },
    onDraft: (draft: string) => setEditing((e) => e && { ...e, draft, error: null }),
    onSave: () => void save(),
    onCancel: () => setEditing(null),
  };

  let body: React.ReactNode = null;
  if (loading && !data) {
    body = (
      <div className="p-10 flex items-center justify-center text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  } else if (data) {
    body = (
      <>
        <TemplatePanel orgIds={orgs.map((o) => o.id)} />
        <OrgGrid orgs={orgs} handlers={handlers} />
        <WarehouseGrid rows={whRows} handlers={handlers} />
        <p className="text-xs text-slate-400">
          Rê chuột lên ô để xem lý do khi số thực dùng khác số đặt. Trần kiện hoàn và các ô kỹ thuật chưa mở
          sửa — nới trần kiện hoàn phải chờ bản agent mới (đợt 7).
        </p>
      </>
    );
  }

  return (
    <PlatformLayout
      pageTitle="Cấu hình các kho"
      pageSubtitle="Mọi tổ chức, mọi kho trên một màn hình. Số to là số hệ thống thật sự chạy."
      pageIcon={SlidersHorizontal}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm tổ chức, mã kho…"
              className="h-9 pl-8 pr-3 rounded-lg border border-slate-200 text-sm w-64 max-w-full"
            />
          </div>
          <label className="h-9 px-3 rounded-lg border border-slate-200 text-sm inline-flex items-center gap-2 bg-white cursor-pointer">
            <input type="checkbox" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} />
            {" "}Chỉ dòng chưa đặt / bị kẹp / không chạy
          </label>
          <button
            type="button"
            onClick={async () => {
              setLoading(true);
              apply(await fetchConfig());
            }}
            className="h-9 px-3 rounded-lg border border-slate-200 text-sm inline-flex items-center gap-1.5 bg-white"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Tải lại
          </button>
          <div className="flex flex-wrap items-center gap-1.5 ml-auto">
            {Object.values(SOURCE_STYLE).map((s) => (
              <span
                key={s.label}
                className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium border ${s.chip}`}
              >
                {s.label}
              </span>
            ))}
          </div>
        </div>

        {data && !data.canEdit && (
          <p className="text-xs text-slate-500">Chỉ xem — sửa cấu hình cần quyền platform_owner.</p>
        )}
        {error && <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">{error}</div>}
        {toast && (
          <div
            className={`p-3 rounded-xl text-sm border ${
              toast.tone === "ok"
                ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                : "bg-amber-50 text-amber-800 border-amber-200"
            }`}
          >
            {toast.text}
          </div>
        )}

        {body}
      </div>
    </PlatformLayout>
  );
}
