"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Server } from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import FleetTable, { type FleetAgentView } from "@/components/platform/FleetTable";
import { apiFetch } from "@/lib/api-fetch";
import { formatVn } from "@/lib/format/time-vn";

/**
 * Đội agent — mọi máy kho trên một màn hình (kế hoạch VAN-HANH-NHIEU-KHO,
 * đợt 7). Số liệu từ bản tự khai của agent (≥ 0.13.0); máy bản cũ hiện
 * "chưa tự khai" chứ không đoán.
 */

interface FleetResponse {
  latestVersion: string;
  selfReportAvailable: boolean;
  agents: FleetAgentView[];
}

type FetchResult = { ok: true; data: FleetResponse } | { ok: false; error: string };

async function fetchFleet(): Promise<FetchResult> {
  try {
    const res = await fetch("/api/platform/agents", { cache: "no-store" });
    const json = await res.json();
    if (res.ok) return { ok: true, data: json as FleetResponse };
    return { ok: false, error: json.message ?? json.error ?? "Không tải được Đội agent." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Lỗi mạng." };
  }
}

interface Diagnostics {
  agentCode: string | null;
  status: string;
  created_at: string;
  result: unknown;
  error: string | null;
}

/** Lệnh chạy khi agent poll (3 giây/lần); chờ tối đa ngần này. */
const DIAG_WAIT_MS = 60_000;

export default function PlatformAgentsPage() {
  const [data, setData] = useState<FleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [notice, setNotice] = useState("");

  const apply = useCallback((r: FetchResult) => {
    if (r.ok) {
      setData(r.data);
      setError("");
    } else {
      setError(r.error);
    }
    setNow(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    let stale = false;
    void fetchFleet().then((r) => {
      if (!stale) apply(r);
    });
    return () => {
      stale = true;
    };
  }, [apply]);

  const diagnose = async (agent: FleetAgentView) => {
    setBusyId(agent.id);
    setNotice("");
    setDiag(null);
    try {
      const res = await apiFetch(`/api/platform/agents/${agent.id}/diagnostics`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setNotice(json.message ?? json.error ?? "Không gửi được lệnh.");
        return;
      }
      const commandId = json.command_id as string;
      const deadline = Date.now() + DIAG_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_000));
        const poll = await fetch(`/api/platform/agents/${agent.id}/diagnostics`, { cache: "no-store" });
        const pj = await poll.json();
        const latest = pj.latest as (Diagnostics & { id: string }) | null;
        if (latest && latest.id === commandId && (latest.status === "done" || latest.status === "failed")) {
          setDiag({ ...latest, agentCode: agent.code });
          return;
        }
      }
      setNotice("Máy kho chưa trả lời sau 60 giây — lệnh vẫn nằm trong hàng, xem lại sau.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Lỗi mạng.");
    } finally {
      setBusyId(null);
    }
  };

  const viewDiagnostics = async (agent: FleetAgentView) => {
    setNotice("");
    try {
      const res = await fetch(`/api/platform/agents/${agent.id}/diagnostics`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.latest) {
        setNotice(json.message ?? json.error ?? "Chưa có kết quả chẩn đoán.");
        return;
      }
      setDiag({ ...json.latest, agentCode: agent.code });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Lỗi mạng.");
    }
  };

  const outdated = data?.agents.filter((a) => a.status === "active" && a.outdated).length ?? 0;

  return (
    <PlatformLayout
      pageTitle="Đội agent"
      pageSubtitle="Mọi máy kho: phiên bản, camera đang ghi, ổ còn mấy ngày, hàng đợi, sự cố mở."
      pageIcon={Server}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              setLoading(true);
              apply(await fetchFleet());
            }}
            className="h-9 px-3 rounded-lg border border-slate-200 text-sm inline-flex items-center gap-1.5 bg-white"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Tải lại
          </button>
          {data && (
            <span className="text-sm text-slate-600">
              Bản mới nhất <span className="font-semibold">{data.latestVersion}</span>
              {outdated > 0 && <span className="text-amber-700"> · {outdated} máy chạy bản cũ</span>}
            </span>
          )}
        </div>

        {data && !data.selfReportAvailable && (
          <p className="p-3 rounded-xl bg-amber-50 text-amber-800 text-sm border border-amber-200">
            Chưa có cột bản tự khai — cần chạy migration 20260926130000. Đang hiện những gì đọc được.
          </p>
        )}
        {error && <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">{error}</div>}
        {notice && (
          <div className="p-3 rounded-xl bg-amber-50 text-amber-800 text-sm border border-amber-200">{notice}</div>
        )}

        {loading && !data ? (
          <div className="p-10 flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          data && (
            <FleetTable
              agents={data.agents}
              latestVersion={data.latestVersion}
              now={now}
              busyId={busyId}
              onDiagnose={(a) => void diagnose(a)}
              onViewDiagnostics={(a) => void viewDiagnostics(a)}
            />
          )
        )}

        {diag && (
          <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">
              Chẩn đoán {diag.agentCode ?? ""} · {formatVn(diag.created_at)} · {diag.status}
            </div>
            {diag.error && <p className="px-4 pt-3 text-sm text-red-600">{diag.error}</p>}
            <pre className="p-4 text-[11px] leading-relaxed text-slate-700 overflow-x-auto max-h-[32rem]">
              {JSON.stringify(diag.result, null, 2)}
            </pre>
          </section>
        )}
      </div>
    </PlatformLayout>
  );
}
