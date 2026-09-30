"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import type { Role } from "@/lib/auth";
import type { PermissionDefinition, RbacRoleDefinition } from "@/lib/rbac-catalog";
import { apiFetch } from "@/lib/api-fetch";

interface MatrixResponse {
  roles: RbacRoleDefinition[];
  permissions: PermissionDefinition[];
  grants: Array<[Role, string]>;
  canEdit: boolean;
}

type Matrix = Record<Role, Set<string>>;
type Notice = { tone: "success" | "error"; text: string } | null;

function emptyMatrix(): Matrix {
  return {
    owner: new Set(),
    admin: new Set(),
    warehouse_manager: new Set(),
    shift_leader: new Set(),
    packer: new Set(),
    viewer: new Set(),
  };
}

function matrixFrom(data: MatrixResponse): Matrix {
  const matrix = emptyMatrix();
  for (const [role, permission] of data.grants) matrix[role]?.add(permission);
  return matrix;
}

function signature(matrix: Matrix): string {
  return Object.entries(matrix)
    .flatMap(([role, permissions]) => [...permissions].sort().map((permission) => `${role}:${permission}`))
    .sort()
    .join("|");
}

async function loadMatrix(): Promise<MatrixResponse> {
  const response = await fetch("/api/platform/permissions", { cache: "no-store" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message ?? json.error ?? "Không tải được ma trận quyền.");
  return json as MatrixResponse;
}

export default function PlatformPermissionsPage() {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [matrix, setMatrix] = useState<Matrix>(emptyMatrix);
  const [savedSignature, setSavedSignature] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextData = await loadMatrix();
      const nextMatrix = matrixFrom(nextData);
      setData(nextData);
      setMatrix(nextMatrix);
      setSavedSignature(signature(nextMatrix));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được ma trận quyền.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stale = false;
    void loadMatrix()
      .then((nextData) => {
        if (stale) return;
        const nextMatrix = matrixFrom(nextData);
        setData(nextData);
        setMatrix(nextMatrix);
        setSavedSignature(signature(nextMatrix));
      })
      .catch((err: unknown) => {
        if (!stale) {
          setError(err instanceof Error ? err.message : "Không tải được ma trận quyền.");
        }
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, []);

  const q = query.trim().toLocaleLowerCase("vi");
  const groups = useMemo(() => {
    const grouped = new Map<string, PermissionDefinition[]>();
    for (const permission of data?.permissions ?? []) {
      if (
        q &&
        !`${permission.label} ${permission.description} ${permission.code}`
          .toLocaleLowerCase("vi")
          .includes(q)
      ) {
        continue;
      }
      const list = grouped.get(permission.group) ?? [];
      list.push(permission);
      grouped.set(permission.group, list);
    }
    return [...grouped.entries()];
  }, [data, q]);

  const dirty = savedSignature !== signature(matrix);

  const toggle = (role: RbacRoleDefinition, permission: string, checked: boolean) => {
    if (!data?.canEdit || role.lockedFullAccess) return;
    setNotice(null);
    setMatrix((current) => {
      const next = { ...current, [role.code]: new Set(current[role.code]) };
      if (checked) next[role.code].add(permission);
      else next[role.code].delete(permission);
      return next;
    });
  };

  const toggleGroup = (
    role: RbacRoleDefinition,
    permissions: PermissionDefinition[],
    checked: boolean,
  ) => {
    if (!data?.canEdit || role.lockedFullAccess) return;
    setNotice(null);
    setMatrix((current) => {
      const next = { ...current, [role.code]: new Set(current[role.code]) };
      for (const permission of permissions) {
        if (checked) next[role.code].add(permission.code);
        else next[role.code].delete(permission.code);
      }
      return next;
    });
  };

  const save = async () => {
    if (!data?.canEdit || !dirty || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const permissions = Object.fromEntries(
        data.roles.map((role) => [role.code, [...matrix[role.code]].sort()]),
      );
      const response = await apiFetch("/api/platform/permissions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.message ?? json.error ?? "Không lưu được ma trận quyền.");
      setSavedSignature(signature(matrix));
      setNotice({
        tone: "success",
        text: `Đã lưu ma trận: thêm ${json.added ?? 0}, thu hồi ${json.removed ?? 0} quyền.`,
      });
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Không lưu được ma trận quyền.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PlatformLayout
      pageTitle="Phân quyền"
      pageSubtitle="Ma trận RBAC dùng chung cho giao diện và API của tất cả tổ chức"
      pageIcon={ShieldCheck}
    >
      <div className="space-y-3">
        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-slate-900">Ma trận quyền theo vai trò</h2>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
                Mỗi ô có hiệu lực ngay cho menu, trang và chốt kiểm tra phía máy chủ. Chủ sở hữu và
                Quản trị hệ thống luôn giữ toàn quyền để bảo đảm còn đường khôi phục cấu hình.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading || saving}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Tải lại
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!data?.canEdit || !dirty || saving}
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Lưu thay đổi
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="relative block min-w-[16rem] flex-1 sm:max-w-sm">
              <span className="sr-only">Tìm quyền</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm chức năng hoặc mã quyền…"
                className="h-9 w-full rounded-xl border border-slate-200 pl-9 pr-3 text-sm text-slate-700 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />
            </label>
            {data && (
              <span className="text-xs text-slate-500">
                {data.permissions.length} quyền · {data.roles.length} vai trò
              </span>
            )}
            {dirty && (
              <span className="rounded-lg bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                Có thay đổi chưa lưu
              </span>
            )}
          </div>

          {!data?.canEdit && data && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
              Tài khoản Hỗ trợ nền tảng chỉ được xem. Chỉ Chủ nền tảng được thay đổi ma trận.
            </div>
          )}

          {notice && (
            <div
              role={notice.tone === "error" ? "alert" : "status"}
              aria-live="polite"
              className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
                notice.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-rose-200 bg-rose-50 text-rose-800"
              }`}
            >
              {notice.tone === "success" ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              {notice.text}
            </div>
          )}
        </section>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm text-slate-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin text-emerald-500" />
            Đang tải ma trận quyền…
          </div>
        ) : error ? (
          <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-semibold">Không tải được ma trận quyền</p>
                <p className="mt-1 text-xs">{error}</p>
              </div>
            </div>
          </div>
        ) : data ? (
          <div className="max-h-[calc(100vh-15rem)] overflow-auto rounded-2xl border border-slate-200 bg-white [scrollbar-gutter:stable]">
            <table className="w-full min-w-[78rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">
                Ma trận các quyền chức năng theo vai trò người dùng trong tổ chức
              </caption>
              <thead className="sticky top-0 z-30 bg-white shadow-[0_1px_0_0_#e2e8f0]">
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 z-40 w-[24rem] min-w-[24rem] bg-white px-4 py-3 text-left text-xs font-semibold text-slate-600"
                  >
                    Chức năng
                  </th>
                  {data.roles.map((role) => (
                    <th key={role.code} scope="col" className="min-w-[9.5rem] px-3 py-3 text-center align-top">
                      <div className="font-semibold text-slate-800">{role.label}</div>
                      <div className="mt-1 text-[10px] font-normal leading-snug text-slate-400">
                        {matrix[role.code].size}/{data.permissions.length}
                      </div>
                      {role.lockedFullAccess && (
                        <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                          <LockKeyhole className="h-3 w-3" /> Cố định
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.length === 0 ? (
                  <tr>
                    <td colSpan={data.roles.length + 1} className="px-4 py-12 text-center text-sm text-slate-500">
                      Không có quyền nào khớp từ khóa.
                    </td>
                  </tr>
                ) : (
                  groups.map(([group, permissions]) => (
                    <PermissionGroupRows
                      key={group}
                      group={group}
                      permissions={permissions}
                      roles={data.roles}
                      matrix={matrix}
                      canEdit={data.canEdit}
                      onToggle={toggle}
                      onToggleGroup={toggleGroup}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </PlatformLayout>
  );
}

function PermissionGroupRows({
  group,
  permissions,
  roles,
  matrix,
  canEdit,
  onToggle,
  onToggleGroup,
}: {
  group: string;
  permissions: PermissionDefinition[];
  roles: RbacRoleDefinition[];
  matrix: Matrix;
  canEdit: boolean;
  onToggle: (role: RbacRoleDefinition, permission: string, checked: boolean) => void;
  onToggleGroup: (role: RbacRoleDefinition, permissions: PermissionDefinition[], checked: boolean) => void;
}) {
  return (
    <>
      <tr className="bg-emerald-50/80">
        <th
          scope="rowgroup"
          className="sticky left-0 z-20 bg-emerald-50 px-4 py-2 text-left text-xs font-bold text-emerald-900"
        >
          {group}
          <span className="ml-2 font-normal text-emerald-700/70">({permissions.length})</span>
        </th>
        {roles.map((role) => {
          const count = permissions.filter((permission) => matrix[role.code].has(permission.code)).length;
          const checked = count === permissions.length;
          return (
            <td key={role.code} className="border-l border-emerald-100 px-3 py-2 text-center">
              <input
                type="checkbox"
                checked={checked}
                disabled={!canEdit || role.lockedFullAccess}
                onChange={(event) => onToggleGroup(role, permissions, event.target.checked)}
                aria-label={`${checked ? "Thu hồi" : "Cấp"} toàn bộ nhóm ${group} cho ${role.label}`}
                className="h-4 w-4 accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-55"
              />
              <span className="ml-1.5 align-[2px] text-[10px] text-emerald-800/70">{count}/{permissions.length}</span>
            </td>
          );
        })}
      </tr>
      {permissions.map((permission) => (
        <tr key={permission.code} className="group border-b border-slate-100 hover:bg-slate-50/70">
          <th
            scope="row"
            className="sticky left-0 z-10 border-t border-slate-100 bg-white px-4 py-2.5 text-left group-hover:bg-slate-50"
          >
            <div className="font-medium text-slate-800">{permission.label}</div>
            <div className="mt-0.5 text-[11px] font-normal leading-snug text-slate-400">
              {permission.description} <code className="ml-1 text-[10px] text-slate-300">{permission.code}</code>
            </div>
          </th>
          {roles.map((role) => {
            const checked = matrix[role.code].has(permission.code);
            return (
              <td key={role.code} className="border-l border-t border-slate-100 px-3 py-2.5 text-center">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canEdit || role.lockedFullAccess}
                  onChange={(event) => onToggle(role, permission.code, event.target.checked)}
                  aria-label={`${checked ? "Thu hồi" : "Cấp"} quyền ${permission.label} cho ${role.label}`}
                  className="h-[1.1rem] w-[1.1rem] accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-55"
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
