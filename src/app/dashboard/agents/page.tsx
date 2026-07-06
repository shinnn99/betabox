"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Server,
  Plus,
  RefreshCw,
  Trash2,
  KeyRound,
  Loader2,
  X,
  Copy,
  Check,
  AlertTriangle,
  Circle,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";

interface AgentRow {
  id: string;
  code: string;
  name: string;
  status: "active" | "inactive";
  last_seen_at: string | null;
  last_discovered_at?: string | null;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "chưa từng";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "chưa từng";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s trước`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  const day = Math.floor(hr / 24);
  return `${day} ngày trước`;
}

function isOnline(iso: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < 60_000;
}

export default function AgentsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [revealSecret, setRevealSecret] = useState<{
    code: string;
    secret: string;
    isReset: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const res = await fetch("/api/warehouse/agents", { cache: "no-store" });
      const data = await res.json();
      setRows((data.agents ?? []) as AgentRow[]);
    } catch {
      toast.error("Không tải được danh sách máy trạm.");
      setRows([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetSecret = async (row: AgentRow) => {
    const ok = await confirm({
      title: `Cấp secret mới cho ${row.code}?`,
      message:
        "Sau khi cấp mới, agent đang chạy trên máy kho sẽ MẤT KẾT NỐI cho tới khi cài lại installer với secret mới. Chỉ dùng khi mất copy secret cũ hoặc lộ secret.",
      confirmLabel: "Cấp mới",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(row.id);
    try {
      const res = await fetch(`/api/warehouse/agents/${row.id}/reset-secret`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message ?? data.error ?? "Reset thất bại");
        return;
      }
      setRevealSecret({
        code: row.code,
        secret: data.secret,
        isReset: true,
      });
      void load();
    } finally {
      setBusy(null);
    }
  };

  const deleteAgent = async (row: AgentRow) => {
    const ok = await confirm({
      title: `Xóa máy trạm ${row.code}?`,
      message:
        "Agent trên máy kho sẽ ngừng hoạt động. Dữ liệu lịch sử (scan, video) KHÔNG bị xóa. Có thể tạo lại agent mới với cùng mã sau này.",
      confirmLabel: "Xóa",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(row.id);
    try {
      const res = await fetch(`/api/warehouse/agents/${row.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.message ?? data.error ?? "Xóa thất bại");
        return;
      }
      toast.success(`Đã xóa ${row.code}`);
      void load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <DashboardLayout
      pageTitle="Máy trạm kho"
      pageSubtitle="Cấu hình máy tính tại kho để cài phần mềm agent Betacom"
      pageIcon={Server}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => void load()}
            className="h-9 w-9 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center justify-center"
            title="Tải lại"
          >
            <RefreshCw className="h-4 w-4 text-slate-500" />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="h-9 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Thêm máy trạm
          </button>
        </div>

        <div className="rounded-2xl bg-white border border-slate-100 shadow-sm overflow-hidden">
          {rows === null ? (
            <div className="p-8 text-center text-slate-500 text-sm inline-flex items-center gap-2 justify-center w-full">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải…
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">
              Chưa có máy trạm nào. Bấm{" "}
              <span className="font-semibold text-emerald-600">Thêm máy trạm</span>{" "}
              để lấy AGENT_CODE + AGENT_SECRET dùng khi cài installer.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500 bg-slate-50">
                <tr>
                  <th className="px-4 py-2 font-semibold">Mã</th>
                  <th className="px-4 py-2 font-semibold">Tên</th>
                  <th className="px-4 py-2 font-semibold">Kết nối</th>
                  <th className="px-4 py-2 font-semibold">Lần cuối</th>
                  <th className="px-4 py-2 font-semibold text-right">Hành động</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const online = isOnline(r.last_seen_at);
                  return (
                    <tr
                      key={r.id}
                      className="border-t border-slate-100 hover:bg-slate-50/50"
                    >
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-800">
                        {r.code}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{r.name}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${
                            online
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          <Circle
                            className={`h-2 w-2 ${
                              online ? "fill-emerald-500 text-emerald-500" : ""
                            }`}
                          />
                          {online ? "Online" : "Offline"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">
                        {formatRelative(r.last_seen_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            disabled={busy === r.id}
                            onClick={() => resetSecret(r)}
                            className="h-8 px-2 rounded-lg border border-slate-200 hover:bg-slate-100 inline-flex items-center gap-1 text-xs text-slate-700 disabled:opacity-50"
                            title="Cấp secret mới (cần cài lại installer)"
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                            Cấp secret mới
                          </button>
                          <button
                            disabled={busy === r.id}
                            onClick={() => deleteAgent(r)}
                            className="h-8 w-8 rounded-lg text-rose-500 hover:bg-rose-50 inline-flex items-center justify-center disabled:opacity-50"
                            title="Xóa máy trạm"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateAgentModal
          onClose={() => setShowCreate(false)}
          onCreated={(code, secret) => {
            setShowCreate(false);
            setRevealSecret({ code, secret, isReset: false });
            void load();
          }}
        />
      )}

      {revealSecret && (
        <RevealSecretModal
          code={revealSecret.code}
          secret={revealSecret.secret}
          isReset={revealSecret.isReset}
          onClose={() => setRevealSecret(null)}
        />
      )}
    </DashboardLayout>
  );
}

function CreateAgentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (code: string, secret: string) => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/warehouse/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message ?? data.error ?? "Tạo thất bại");
        return;
      }
      onCreated(data.agent.code, data.secret);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-800">Thêm máy trạm</h2>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded-lg hover:bg-slate-100 inline-flex items-center justify-center text-slate-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-slate-600">
              Mã máy trạm <span className="text-rose-500">*</span>
            </label>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Chữ HOA, số, dấu <code>_</code> hoặc <code>-</code>. Ví dụ: AGENT_KHO_HN_01.
            </p>
            <input
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="AGENT_KHO_HN_01"
              className="mt-1 w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
              maxLength={64}
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600">
              Tên gọi <span className="text-rose-500">*</span>
            </label>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Đặt tên gợi nhớ: kho nào, PC nào.
            </p>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Máy PC kho Hà Nội — bàn 1"
              className="mt-1 w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
              maxLength={100}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 rounded-xl border border-slate-200 text-sm"
            >
              Huỷ
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Tạo
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RevealSecretModal({
  code,
  secret,
  isReset,
  onClose,
}: {
  code: string;
  secret: string;
  isReset: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState<"code" | "secret" | null>(null);
  const [ack, setAck] = useState(false);

  const copy = async (kind: "code" | "secret", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Không copy được. Hãy tự chọn và Ctrl+C.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-800">
            {isReset ? "Secret mới đã được cấp" : "Máy trạm đã tạo"}
          </h2>
        </div>

        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Copy ngay 2 giá trị dưới đây.</p>
            <p className="text-xs mt-0.5">
              Đóng cửa sổ này = MẤT secret vĩnh viễn. Nếu quên copy, phải bấm{" "}
              <em>Cấp secret mới</em> — agent cũ ngừng hoạt động cho tới khi cài lại.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <SecretField
            label="AGENT_CODE"
            value={code}
            copied={copied === "code"}
            onCopy={() => void copy("code", code)}
          />
          <SecretField
            label="AGENT_SECRET"
            value={secret}
            copied={copied === "secret"}
            onCopy={() => void copy("secret", secret)}
            mono
          />
        </div>

        <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-600">
          <p className="font-semibold text-slate-700 mb-1">Bước tiếp theo</p>
          <ol className="space-y-0.5 list-decimal ml-4">
            <li>Tải file cài <code>BetacomAgentSetup-vX.Y.Z.exe</code> từ Betacom.</li>
            <li>Chạy Run as administrator trên máy PC ở kho.</li>
            <li>Nhập 2 giá trị vừa copy vào 2 field tương ứng của installer.</li>
            <li>Chờ ~2 phút, dashboard sẽ thấy máy trạm chuyển sang <em>Online</em>.</li>
          </ol>
        </div>

        <label className="mt-4 flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5"
          />
          <span>Tôi đã copy AGENT_CODE và AGENT_SECRET vào nơi an toàn.</span>
        </label>

        <div className="flex justify-end mt-3">
          <button
            disabled={!ack}
            onClick={onClose}
            className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Đã copy, đóng
          </button>
        </div>
      </div>
    </div>
  );
}

function SecretField({
  label,
  value,
  copied,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-600">{label}</label>
      <div className="mt-1 flex items-stretch gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={`flex-1 h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm ${
            mono ? "font-mono" : ""
          }`}
        />
        <button
          onClick={onCopy}
          className={`h-10 px-3 rounded-xl inline-flex items-center gap-1 text-sm font-semibold ${
            copied
              ? "bg-emerald-500 text-white"
              : "bg-slate-100 hover:bg-slate-200 text-slate-700"
          }`}
        >
          {copied ? (
            <>
              <Check className="h-4 w-4" /> Đã copy
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" /> Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}
