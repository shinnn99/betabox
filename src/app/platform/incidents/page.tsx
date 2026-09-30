"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Siren } from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import Select from "@/components/ui/Select";
import { apiFetch } from "@/lib/api-fetch";
import IncidentTable, { type IncidentActionKind, type IncidentItem } from "@/components/platform/IncidentTable";
import { CHECK_LABELS } from "@/lib/system/check-labels";
import { ago, formatVn } from "@/lib/format/time-vn";

/**
 * Trang Sự cố — sổ `warehouse_incidents` của MỌI kho (kế hoạch
 * VAN-HANH-NHIEU-KHO, đợt 4). Mặc định: đang mở, nặng trước.
 *
 * Sổ chỉ được ghi bởi lượt tự kiểm nền. Nên trang này nói rõ lượt đó chạy
 * lần cuối khi nào — và nói TO khi nó đã ngừng: sổ rỗng lúc con tự kiểm chết
 * trông y hệt sổ rỗng lúc mọi thứ khoẻ (kế hoạch, phần 4.6, lớp 3).
 */

type StatusFilter = "active" | "resolved" | "all";

interface IncidentsResponse {
  incidents: IncidentItem[];
  orgs: Array<{ id: string; name: string }>;
  lastBackgroundRun: string | null;
}

/** Lượt tự kiểm chạy mỗi 15 phút; quá ngần này là coi như đã ngừng. */
const STALE_BACKGROUND_MS = 60 * 60_000;

type FetchResult =
  | { ok: true; data: IncidentsResponse }
  | { ok: false; error: string; network: boolean };

async function fetchIncidents(status: StatusFilter, org: string): Promise<FetchResult> {
  try {
    const params = new URLSearchParams({ status });
    if (org) params.set("org", org);
    const res = await fetch(`/api/platform/incidents?${params}`, { cache: "no-store" });
    const json = await res.json();
    if (res.ok) return { ok: true, data: json as IncidentsResponse };
    return { ok: false, error: json.message ?? json.error ?? "Không tải được sổ sự cố.", network: false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Lỗi mạng.", network: true };
  }
}

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: "active", label: "Đang mở" },
  { value: "resolved", label: "Đã đóng" },
  { value: "all", label: "Tất cả" },
];

export default function PlatformIncidentsPage() {
  const [status, setStatus] = useState<StatusFilter>("active");
  const [org, setOrg] = useState("");
  const [data, setData] = useState<IncidentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback((r: FetchResult) => {
    if (r.ok) {
      setData(r.data);
      setError("");
    } else {
      setError(r.error);
      if (!r.network) setData(null);
    }
    setNow(Date.now());
    setLoading(false);
  }, []);

  // setState chỉ trong callback, và bỏ kết quả của lượt cũ: đổi bộ lọc nhanh
  // thì câu trả lời của bộ lọc trước về muộn không được đè lên bộ lọc mới.
  useEffect(() => {
    let stale = false;
    void fetchIncidents(status, org).then((r) => {
      if (!stale) apply(r);
    });
    return () => {
      stale = true;
    };
  }, [apply, status, org]);

  const reload = async () => {
    setLoading(true);
    apply(await fetchIncidents(status, org));
  };

  const orgNames = useMemo(
    () => Object.fromEntries((data?.orgs ?? []).map((o) => [o.id, o.name])),
    [data],
  );

  const onAction = async (incident: IncidentItem, action: IncidentActionKind) => {
    if (
      action === "resolve" &&
      !globalThis.confirm(
        `Đóng sự cố "${incident.where_label} — ${incident.what_label}"?\n\n` +
          "Nếu lỗi thực ra vẫn còn, lượt tự kiểm kế tiếp sẽ mở lại thành một dòng mới.",
      )
    ) {
      return;
    }
    setBusyId(incident.id);
    setNotice("");
    try {
      const res = await apiFetch(`/api/platform/incidents/${incident.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) {
        // 409: người khác vừa bấm, hoặc lượt tự kiểm vừa đóng — tải lại để thấy thật.
        setNotice(json.message ?? json.error ?? "Không thực hiện được.");
      } else if (json.audit?.ok === false) {
        setNotice(`Đã cập nhật, nhưng KHÔNG ghi được nhật ký kiểm toán: ${json.audit.error}`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Lỗi mạng.");
    } finally {
      setBusyId(null);
      await reload();
    }
  };

  const last = data?.lastBackgroundRun ?? null;
  const stale = !last || now - new Date(last).getTime() > STALE_BACKGROUND_MS;
  const crit = data?.incidents.filter((i) => i.status !== "resolved" && i.severity === "crit").length ?? 0;
  const warn = data?.incidents.filter((i) => i.status !== "resolved" && i.severity === "warn").length ?? 0;

  let body: React.ReactNode = null;
  if (loading && !data) {
    body = (
      <div className="p-10 flex items-center justify-center text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  } else if (data && data.incidents.length === 0) {
    body = (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 text-center">
        {status === "resolved" ? "Chưa có sự cố nào được đóng." : "Không có sự cố nào đang mở."}
        {stale && status !== "resolved" && " — nhưng lượt tự kiểm nền đã ngừng, nên điều này chưa chắc là khoẻ."}
      </div>
    );
  } else if (data) {
    body = (
      <IncidentTable
        incidents={data.incidents}
        orgNames={orgNames}
        checkLabels={CHECK_LABELS}
        now={now}
        busyId={busyId}
        onAction={(i, a) => void onAction(i, a)}
      />
    );
  }

  return (
    <PlatformLayout
      pageTitle="Sự cố"
      pageSubtitle="Sổ sự cố của mọi kho — do lượt tự kiểm nền ghi mỗi 15 phút."
      pageIcon={Siren}
    >
      <div className="p-4 sm:p-6 space-y-4">
        {data && stale && (
          <div className="p-4 rounded-2xl bg-red-600 text-white">
            <p className="text-base font-semibold">Lượt tự kiểm nền đã ngừng — sổ này đang KHÔNG được cập nhật</p>
            <p className="text-sm text-red-100 mt-1">
              {last ? `Lần chạy cuối: ${formatVn(last)} (${ago(last, now)}).` : "Chưa chạy lần nào."} Sự cố mới sẽ
              không vào sổ và sự cố đã khỏi sẽ không tự đóng. Cài lại timer theo kế hoạch VẬN HÀNH NHIỀU KHO, phần 1.2.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
            {STATUS_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => {
                  setLoading(true);
                  setStatus(t.value);
                }}
                className={`h-8 px-3 rounded-md text-sm ${
                  status === t.value ? "bg-slate-800 text-white" : "text-slate-600"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Select
            ariaLabel="Lọc theo shop"
            value={org}
            onChange={(value) => {
              setLoading(true);
              setOrg(value);
            }}
            options={[
              { value: "", label: "Mọi shop" },
              { value: "system", label: "Hệ thống (VPS, cron)" },
              ...(data?.orgs ?? []).map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
            size="sm"
            className="w-56"
          />
          <button
            type="button"
            onClick={() => void reload()}
            className="h-9 px-3 rounded-lg border border-slate-200 text-sm inline-flex items-center gap-1.5 bg-white"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Tải lại
          </button>
          {data && status !== "resolved" && (
            <span className="text-sm text-slate-600">
              <span className="font-semibold text-red-700">{crit}</span> nghiêm trọng ·{" "}
              <span className="font-semibold text-amber-700">{warn}</span> cảnh báo
            </span>
          )}
          {data && !stale && last && (
            <span className="text-xs text-slate-400 ml-auto">Tự kiểm lần cuối: {ago(last, now)}</span>
          )}
        </div>

        {error && <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">{error}</div>}
        {notice && (
          <div className="p-3 rounded-xl bg-amber-50 text-amber-800 text-sm border border-amber-200">{notice}</div>
        )}

        {body}
      </div>
    </PlatformLayout>
  );
}
