"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  ScrollText,
  Loader2,
  RefreshCcw,
  Search,
  ChevronDown,
  AlertTriangle,
  Info,
  Building2,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import Select from "@/components/ui/Select";
import {
  presentAudit,
  GROUP_LABELS,
  SEVERITY_LABELS,
  type AuditRowInput,
  type PresentedAudit,
} from "@/lib/audit-view/presenter";

/**
 * Nhật ký các kho — gộp thao tác BÊN TRONG mọi tổ chức về một dòng thời gian.
 *
 * Khác trang "Nhật ký kiểm toán" (/platform/audit): trang kia ghi thao tác
 * CỦA quản trị nền tảng (impersonate, tạo/khoá tổ chức) từ bảng
 * `platform_audit_log`. Trang này đọc `audit_logs` — việc người trong kho
 * làm. Hai bảng, hai mục đích, nên để hai trang.
 *
 * Cách trình bày dùng chung `@/lib/audit-view/presenter` với trang kho, nên
 * sửa nhãn một lần là cả hai nơi cùng đổi.
 */

interface OrgAuditRow extends AuditRowInput {
  organization_id: string | null;
  organization_name: string | null;
}

interface OrgOption {
  id: string;
  name: string;
}

export default function PlatformOrgAuditPage() {
  const [logs, setLogs] = useState<OrgAuditRow[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [orgId, setOrgId] = useState("all");
  const [q, setQ] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");

  // Lọc theo kho gửi lên máy chủ, KHÔNG lọc ở trình duyệt: lọc phía client
  // vẫn kéo dữ liệu mọi kho xuống máy, và làm hỏng ý nghĩa của giới hạn 200
  // dòng (200 dòng mới nhất của MỌI kho, lọc xong còn vài dòng kho cần xem).
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch(
      `/api/platform/org-audit?limit=200&org_id=${encodeURIComponent(orgId)}`,
      { cache: "no-store" },
    );
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được nhật ký.");
      setLoading(false);
      return;
    }
    setLogs(data.logs);
    setOrgs(data.organizations ?? []);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const presented = useMemo(
    () => logs.map((row) => ({ row, view: presentAudit(row) })),
    [logs],
  );

  const orgOptions = useMemo(
    () => [
      { value: "all", label: "Tất cả các kho" },
      ...orgs.map((o) => ({ value: o.id, label: o.name })),
    ],
    [orgs],
  );

  const groupOptions = useMemo(() => {
    const present = new Set(presented.map((p) => p.view.group));
    return [
      { value: "all", label: "Mảng việc: Tất cả" },
      ...[...present].map((g) => ({ value: g, label: GROUP_LABELS[g] })),
    ];
  }, [presented]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return presented.filter(({ row, view }) => {
      if (groupFilter !== "all" && view.group !== groupFilter) return false;
      if (severityFilter !== "all" && view.severity !== severityFilter)
        return false;
      if (needle) {
        const hay = [
          view.sentence,
          view.actorLabel,
          view.targetLabel ?? "",
          view.action,
          row.organization_name ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [presented, q, groupFilter, severityFilter]);

  const days = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const item of filtered) {
      const key = dayKey(item.view.createdAt);
      const arr = map.get(key) ?? [];
      arr.push(item);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  const showOrgBadge = orgId === "all";
  const selectedOrgName =
    orgId === "all" ? null : orgs.find((o) => o.id === orgId)?.name ?? null;

  return (
    <PlatformLayout
      pageTitle="Nhật ký các kho"
      pageSubtitle="Người trong kho đã làm gì — gộp mọi tổ chức, chọn kho để xem riêng"
      pageIcon={ScrollText}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-60">
            <Select
              value={orgId}
              onChange={setOrgId}
              options={orgOptions}
              ariaLabel="Chọn kho"
              leadingIcon={<Building2 className="h-4 w-4" />}
            />
          </div>
          <div className="flex items-center gap-2 h-10 px-3 rounded-xl border border-slate-200 bg-white text-slate-500 flex-1 min-w-[220px]">
            <Search className="h-4 w-4" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm theo người làm, tên camera, tên nhân viên..."
              className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
            />
          </div>
          <div className="w-52">
            <Select
              value={groupFilter}
              onChange={setGroupFilter}
              options={groupOptions}
              ariaLabel="Mảng việc"
            />
          </div>
          <div className="w-44">
            <Select
              value={severityFilter}
              onChange={setSeverityFilter}
              options={[
                { value: "all", label: "Mức độ: Tất cả" },
                { value: "critical", label: SEVERITY_LABELS.critical },
                { value: "warning", label: SEVERITY_LABELS.warning },
                { value: "info", label: SEVERITY_LABELS.info },
              ]}
              ariaLabel="Mức độ"
            />
          </div>
          <button
            onClick={load}
            className="h-10 px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-sm inline-flex items-center gap-2 text-slate-600"
          >
            <RefreshCcw className="h-4 w-4" /> Làm mới
          </button>
        </div>

        <p className="text-xs text-slate-500 px-1">
          {selectedOrgName ? `Kho ${selectedOrgName} · ` : "Mọi kho · "}
          Đang xem {filtered.length} việc
          {filtered.length !== presented.length &&
            ` (lọc từ ${presented.length})`}
          {" · "}200 việc gần nhất
        </p>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
            {error}
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-10 flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
            Đang tải...
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-10 text-center text-sm text-slate-500">
            {presented.length === 0
              ? "Chưa có việc nào được ghi lại."
              : "Không có việc nào khớp với ô lọc."}
          </div>
        ) : (
          <div className="space-y-5">
            {days.map(([key, items]) => (
              <div key={key}>
                <p className="px-1 pb-2 text-xs">
                  <span className="font-semibold text-slate-700">
                    {dayLabel(key)}
                  </span>
                  <span className="text-slate-400"> · {items.length} việc</span>
                </p>
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                  <ul className="divide-y divide-slate-100">
                    {items.map(({ row, view }) => (
                      <AuditItem
                        key={view.id}
                        entry={view}
                        orgName={showOrgBadge ? row.organization_name : null}
                      />
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PlatformLayout>
  );
}

function AuditItem({
  entry,
  orgName,
}: {
  entry: PresentedAudit;
  orgName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = entry.changes.length > 0 || entry.notes.length > 0;

  return (
    <li className="p-4">
      <div className="flex items-start gap-3">
        <SeverityDot severity={entry.severity} />

        <div className="min-w-0 flex-1">
          {orgName && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded mb-1">
              <Building2 className="h-3 w-3" />
              {orgName}
            </span>
          )}
          <p className="text-sm text-slate-800 leading-relaxed">
            {entry.sentence}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {timeLabel(entry.createdAt)} · {GROUP_LABELS[entry.group]}
          </p>

          {entry.notes.length > 0 && (
            <ul className="mt-2 space-y-1">
              {entry.notes.map((n) => (
                <li
                  key={n}
                  className="text-xs text-slate-600 flex items-start gap-1.5"
                >
                  <Info className="h-3.5 w-3.5 mt-px shrink-0 text-slate-400" />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}

          {entry.changes.length > 0 && (
            <div className="mt-2.5 rounded-xl border border-slate-100 bg-slate-50/60 overflow-hidden">
              <table className="w-full text-xs">
                <tbody>
                  {entry.changes.map((c) => (
                    <tr
                      key={c.field}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="px-3 py-1.5 text-slate-500 w-40 align-top">
                        {c.label}
                      </td>
                      <td className="px-3 py-1.5 text-slate-500 line-through break-all">
                        {c.from}
                      </td>
                      <td className="px-2 py-1.5 text-slate-300 w-6 text-center">
                        →
                      </td>
                      <td className="px-3 py-1.5 text-slate-800 font-medium break-all">
                        {c.to}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {hasDetail && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="mt-2 text-xs text-slate-400 hover:text-slate-600 inline-flex items-center gap-1"
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
              />
              Chi tiết kỹ thuật
            </button>
          )}

          {open && (
            <p className="mt-1.5 text-[11px] font-mono text-slate-400 break-all">
              {entry.action}
            </p>
          )}
        </div>

        {entry.severity === "critical" && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded shrink-0">
            <AlertTriangle className="h-3 w-3" />
            Quan trọng
          </span>
        )}
      </div>
    </li>
  );
}

function SeverityDot({ severity }: { severity: PresentedAudit["severity"] }) {
  const tone = {
    critical: "bg-red-500",
    warning: "bg-amber-400",
    info: "bg-slate-300",
  }[severity];
  return (
    <span
      className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${tone}`}
      title={SEVERITY_LABELS[severity]}
      aria-hidden
    />
  );
}

/* ---------------- Thời gian ---------------- */

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(key: string): string {
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  if (key === today) return "Hôm nay";
  if (key === yesterday) return "Hôm qua";
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
