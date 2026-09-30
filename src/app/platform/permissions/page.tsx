"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  Crown,
  Eye,
  Info,
  LayoutDashboard,
  Loader2,
  LockKeyhole,
  Package,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  Warehouse,
  X,
  type LucideIcon,
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

/** Icon + màu nhận diện từng vai trò trên đầu cột. */
const ROLE_STYLE: Record<Role, { icon: LucideIcon; text: string; badge: string }> = {
  owner: { icon: Crown, text: "text-amber-500", badge: "bg-amber-50" },
  admin: { icon: UserCog, text: "text-blue-600", badge: "bg-blue-50" },
  warehouse_manager: { icon: Warehouse, text: "text-violet-600", badge: "bg-violet-50" },
  shift_leader: { icon: ClipboardList, text: "text-pink-600", badge: "bg-pink-50" },
  packer: { icon: Package, text: "text-emerald-600", badge: "bg-emerald-50" },
  viewer: { icon: Eye, text: "text-slate-600", badge: "bg-slate-100" },
};

const GROUP_ICON: Record<string, LucideIcon> = {
  "Tổng quan": LayoutDashboard,
  "Vận hành kho": Activity,
  "Quản lý kho": Warehouse,
  "Nhân sự kho": Users,
  "Báo cáo": BarChart3,
  "Quản lý hệ thống": Settings,
  "Quyền cũ": CircleHelp,
};

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
  // Nhóm mã cũ không còn tác dụng nên thu gọn sẵn, tránh làm rối bảng.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["Quyền cũ"]));

  const toggleCollapsed = (group: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

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

  const alwaysOn = useMemo(
    () => new Set((data?.permissions ?? []).filter((p) => p.alwaysOn).map((p) => p.code)),
    [data],
  );

  const toggle = (role: RbacRoleDefinition, permission: string, checked: boolean) => {
    if (!data?.canEdit || role.lockedFullAccess || alwaysOn.has(permission)) return;
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
        if (permission.alwaysOn) continue;
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
                    className="sticky left-0 z-40 w-[22rem] min-w-[22rem] bg-slate-50/95 px-4 py-4 text-left align-middle text-sm font-medium text-slate-600"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-slate-400" /> Quyền / Vai trò
                    </span>
                  </th>
                  {data.roles.map((role) => {
                    const style = ROLE_STYLE[role.code];
                    const RoleIcon = style?.icon ?? Users;
                    return (
                      <th
                        key={role.code}
                        scope="col"
                        title={role.description}
                        className="min-w-[9rem] border-l border-slate-100 bg-slate-50/95 px-3 py-3 text-center align-top"
                      >
                        <span className={`mx-auto flex h-8 w-8 items-center justify-center rounded-lg ${style?.badge ?? "bg-slate-100"}`}>
                          <RoleIcon className={`h-4 w-4 ${style?.text ?? "text-slate-600"}`} />
                        </span>
                        <div className={`mt-1.5 text-sm font-semibold ${style?.text ?? "text-slate-800"}`}>{role.label}</div>
                        {role.lockedFullAccess && (
                          <LockKeyhole className="mx-auto mt-1 h-3 w-3 text-slate-300" aria-label="Cố định toàn quyền" />
                        )}
                        <div className="mt-1 text-[11px] font-normal tabular-nums text-slate-400">
                          {matrix[role.code].size}/{data.permissions.length}
                        </div>
                      </th>
                    );
                  })}
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
                      collapsed={!q && collapsed.has(group)}
                      onToggleCollapsed={() => toggleCollapsed(group)}
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

/** Ô quyền dạng chấm tròn như bảng phân quyền chuẩn; input native vẫn giữ để bàn phím/đọc màn hình dùng được. */
function PermissionCell({
  checked,
  locked,
  disabled,
  label,
  onChange,
}: Readonly<{
  checked: boolean;
  locked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}>) {
  let tone = "bg-slate-50 text-slate-300 ring-slate-200";
  if (checked) tone = locked ? "bg-slate-100 text-slate-500 ring-slate-200" : "bg-emerald-100 text-emerald-600 ring-emerald-200";
  return (
    <label className={`relative inline-flex ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        className="peer sr-only"
      />
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full ring-1 transition peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500 ${tone} ${
          disabled ? "" : "hover:scale-110 hover:ring-emerald-300"
        }`}
      >
        {checked ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <X className="h-3 w-3" />}
      </span>
    </label>
  );
}

function PermissionGroupRows({
  group,
  permissions,
  roles,
  matrix,
  canEdit,
  collapsed,
  onToggleCollapsed,
  onToggle,
  onToggleGroup,
}: Readonly<{
  group: string;
  permissions: PermissionDefinition[];
  roles: RbacRoleDefinition[];
  matrix: Matrix;
  canEdit: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggle: (role: RbacRoleDefinition, permission: string, checked: boolean) => void;
  onToggleGroup: (role: RbacRoleDefinition, permissions: PermissionDefinition[], checked: boolean) => void;
}>) {
  const GroupIcon = GROUP_ICON[group] ?? CircleHelp;
  return (
    <>
      <tr className="bg-slate-50/80">
        <th
          scope="rowgroup"
          className="sticky left-0 z-20 border-t border-slate-200 bg-slate-50 px-4 py-3 text-left"
        >
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            className="flex w-full items-center gap-2.5 text-sm font-bold uppercase tracking-wide text-slate-800"
          >
            <GroupIcon className="h-4 w-4 text-slate-500" />
            {group}
            <span className="font-normal normal-case text-slate-400">({permissions.length})</span>
            <ChevronDown className={`ml-auto h-4 w-4 text-slate-400 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
          </button>
        </th>
        {roles.map((role) => {
          const count = permissions.filter((permission) => matrix[role.code].has(permission.code)).length;
          const full = count === permissions.length;
          const partial = count > 0 && !full;
          const disabled = !canEdit || !!role.lockedFullAccess;
          let tone = "border-slate-200 bg-white";
          if (full) tone = role.lockedFullAccess ? "border-emerald-200 bg-emerald-100" : "border-emerald-600 bg-emerald-500";
          else if (partial) tone = "border-emerald-600 bg-white";
          return (
            <td key={role.code} className="border-l border-t border-slate-200 px-3 py-3 text-center">
              <label
                title={`${count}/${permissions.length} quyền`}
                className={`relative inline-flex ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={full}
                  ref={(el) => {
                    if (el) el.indeterminate = partial;
                  }}
                  disabled={disabled}
                  onChange={(event) => onToggleGroup(role, permissions, event.target.checked)}
                  aria-label={`${full ? "Thu hồi" : "Cấp"} toàn bộ nhóm ${group} cho ${role.label} (${count}/${permissions.length})`}
                  className="peer sr-only"
                />
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border-[3px] peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500 peer-focus-visible:ring-offset-1 ${tone}`}
                >
                  {full || partial ? (
                    <span className={`h-2 w-2 rounded-full ${full && !role.lockedFullAccess ? "bg-white" : "bg-emerald-600"}`} />
                  ) : null}
                </span>
              </label>
            </td>
          );
        })}
      </tr>
      {!collapsed &&
        permissions.map((permission) => (
          <tr key={permission.code} className="group hover:bg-slate-50/70">
            <th
              scope="row"
              className="sticky left-0 z-10 border-t border-slate-100 bg-white py-2.5 pl-11 pr-4 text-left font-normal group-hover:bg-slate-50"
            >
              <span className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                {permission.label}
                <span
                  tabIndex={0}
                  title={`${permission.description} (${permission.code})`}
                  aria-label={`${permission.description} Mã quyền ${permission.code}`}
                  className="inline-flex cursor-help text-slate-300 outline-none hover:text-slate-500 focus-visible:text-emerald-600"
                >
                  <Info className="h-3.5 w-3.5" />
                </span>
                {permission.alwaysOn && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                    <LockKeyhole className="h-3 w-3" /> Luôn bật
                  </span>
                )}
              </span>
            </th>
            {roles.map((role) => {
              const checked = matrix[role.code].has(permission.code);
              return (
                <td key={role.code} className="border-l border-t border-slate-100 px-3 py-2 text-center">
                  <PermissionCell
                    checked={checked}
                    locked={!!role.lockedFullAccess || !!permission.alwaysOn}
                    disabled={!canEdit || !!role.lockedFullAccess || !!permission.alwaysOn}
                    label={`${checked ? "Thu hồi" : "Cấp"} quyền ${permission.label} cho ${role.label}`}
                    onChange={(next) => onToggle(role, permission.code, next)}
                  />
                </td>
              );
            })}
          </tr>
        ))}
    </>
  );
}
