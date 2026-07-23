"use client";

import { useEffect, useState } from "react";
import {
  Building2,
  Users,
  Warehouse,
  ArrowRight,
  Loader2,
  Search,
  Plus,
  X,
  Copy,
  Check,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";

async function impersonateOrg(orgId: string) {
  const res = await fetch("/api/platform/impersonate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message ?? data.error ?? "Vào tổ chức thất bại");
  }
  // Cookie đã set → redirect về dashboard (proxy sẽ ký token từ cookie).
  window.location.href = "/dashboard";
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  stats: { users: number; warehouses: number };
}

interface CreatedOrgResult {
  organization: { id: string; name: string; slug: string };
  owner: { user_id: string; email: string; full_name: string; password?: string };
}

export default function PlatformOrgsPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createdResult, setCreatedResult] = useState<CreatedOrgResult | null>(null);

  const reload = async () => {
    const res = await fetch("/api/platform/orgs", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được danh sách.");
    } else {
      setOrgs(data.orgs);
      setError("");
    }
    setLoading(false);
  };

  useEffect(() => {
    reload();
  }, []);

  const filtered = orgs.filter(
    (o) =>
      o.name.toLowerCase().includes(q.toLowerCase()) ||
      o.slug.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <PlatformLayout
      pageTitle="Tổ chức"
      pageSubtitle="Danh sách mọi tổ chức trên hệ thống — bấm để vào xem"
      pageIcon={Building2}
    >
      <div className="space-y-3">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 h-9 px-3 rounded-xl border border-slate-200 bg-slate-50/60 text-slate-500 flex-1 max-w-sm">
              <Search className="h-4 w-4" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Tìm tên hoặc slug tổ chức..."
                className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
              />
            </div>
            <div className="text-xs text-slate-500 ml-auto">
              Tổng: <b>{orgs.length}</b>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="h-9 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold inline-flex items-center gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> Tạo tổ chức mới
            </button>
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 text-red-600 text-sm border-b border-red-100">
              {error}
            </div>
          )}

          {loading ? (
            <div className="p-8 flex items-center justify-center text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
              Đang tải...
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              {q ? "Không tìm thấy tổ chức khớp." : "Chưa có tổ chức nào."}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filtered.map((org) => (
                <div
                  key={org.id}
                  className="p-4 flex items-center gap-4 hover:bg-slate-50/50"
                >
                  <div className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 border border-emerald-100">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800 truncate">
                      {org.name}
                    </p>
                    <p className="text-xs text-slate-500 font-mono">{org.slug}</p>
                  </div>
                  <div className="hidden md:flex items-center gap-4 text-xs text-slate-500">
                    <div className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      <span>{org.stats.users}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Warehouse className="h-3.5 w-3.5" />
                      <span>{org.stats.warehouses}</span>
                    </div>
                    <div className="text-slate-400">
                      {new Date(org.created_at).toLocaleDateString("vi-VN")}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      impersonateOrg(org.id).catch((e) => setError(e.message));
                    }}
                    className="h-9 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    Vào xem <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateOrgModal
          onClose={() => setShowCreate(false)}
          onCreated={(result) => {
            setCreatedResult(result);
            setShowCreate(false);
            reload();
          }}
        />
      )}

      {createdResult && (
        <CreatedResultModal
          result={createdResult}
          onClose={() => setCreatedResult(null)}
        />
      )}
    </PlatformLayout>
  );
}

function CreateOrgModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: CreatedOrgResult) => void;
}) {
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [orgName, setOrgName] = useState("");
  const [slugOverride, setSlugOverride] = useState("");
  const [manualPassword, setManualPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/platform/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_email: ownerEmail,
          owner_full_name: ownerFullName,
          owner_phone: ownerPhone || null,
          organization_name: orgName,
          slug_override: slugOverride || undefined,
          password: manualPassword || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.message ?? data.error ?? "Tạo thất bại.");
        return;
      }
      onCreated(data as CreatedOrgResult);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-800">Tạo tổ chức mới</h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg hover:bg-slate-100 text-slate-500 flex items-center justify-center"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Tên tổ chức <span className="text-red-500">*</span>
            </label>
            <input
              required
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Ví dụ: Betacom Kho Đà Nẵng"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Slug (URL định danh — bỏ trắng để auto)
            </label>
            <input
              value={slugOverride}
              onChange={(e) => setSlugOverride(e.target.value)}
              placeholder="Auto từ tên tổ chức"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <hr className="border-slate-100" />
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Email chủ tài khoản <span className="text-red-500">*</span>
            </label>
            <input
              required
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="owner@example.com"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Họ tên chủ tài khoản <span className="text-red-500">*</span>
            </label>
            <input
              required
              value={ownerFullName}
              onChange={(e) => setOwnerFullName(e.target.value)}
              placeholder="Nguyễn Văn A"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Số điện thoại (tùy chọn)
            </label>
            <input
              value={ownerPhone}
              onChange={(e) => setOwnerPhone(e.target.value)}
              placeholder="0912345678"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Mật khẩu (bỏ trắng để tự tạo random)
            </label>
            <input
              type="text"
              value={manualPassword}
              onChange={(e) => setManualPassword(e.target.value)}
              placeholder="Auto random nếu bỏ trắng"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <p className="text-xs text-slate-400 mt-1">
              Tối thiểu 8 ký tự. Auto random sẽ trả về ở màn kết quả để copy.
            </p>
          </div>

          {err && (
            <div className="p-2 rounded-lg bg-red-50 text-red-600 text-xs">
              {err}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-10 rounded-lg border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 h-10 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "Đang tạo..." : "Tạo tổ chức"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreatedResultModal({
  result,
  onClose,
}: {
  result: CreatedOrgResult;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-emerald-50">
          <h2 className="font-semibold text-emerald-900">Đã tạo tổ chức</h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg hover:bg-emerald-100 text-emerald-700 flex items-center justify-center"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
            Chép thông tin dưới đây gửi khách. Mật khẩu chỉ hiển thị 1 lần —
            đóng cửa sổ này là không xem lại được.
          </div>

          <Field
            label="Tên tổ chức"
            value={result.organization.name}
            copyKey="name"
            copied={copied}
            onCopy={copy}
          />
          <Field
            label="Slug"
            value={result.organization.slug}
            copyKey="slug"
            copied={copied}
            onCopy={copy}
            mono
          />
          <Field
            label="Email đăng nhập"
            value={result.owner.email}
            copyKey="email"
            copied={copied}
            onCopy={copy}
          />
          {result.owner.password && (
            <Field
              label="Mật khẩu (auto random — chỉ hiển thị lần này)"
              value={result.owner.password}
              copyKey="password"
              copied={copied}
              onCopy={copy}
              mono
              highlight
            />
          )}

          <button
            onClick={onClose}
            className="w-full h-10 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-sm font-semibold"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  copyKey,
  copied,
  onCopy,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  copyKey: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <div
          className={`flex-1 h-10 px-3 rounded-lg border text-sm flex items-center ${
            highlight
              ? "border-emerald-300 bg-emerald-50 text-emerald-900 font-semibold"
              : "border-slate-200 bg-slate-50 text-slate-700"
          } ${mono ? "font-mono" : ""}`}
        >
          {value}
        </div>
        <button
          onClick={() => onCopy(value, copyKey)}
          className="h-10 w-10 rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center justify-center text-slate-600"
          title="Sao chép"
        >
          {copied === copyKey ? (
            <Check className="h-4 w-4 text-emerald-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
