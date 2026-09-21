"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiFetch, useImpersonatingOrgId } from "./api-fetch";

type PermissionSet = Set<string> | "all";

/**
 * Nhớ theo (user, tổ chức đang xem): mọi trang dashboard dùng chung một
 * lượt tải, đổi tài khoản / đổi tổ chức thì tải lại.
 */
const cache = new Map<string, Promise<PermissionSet | null>>();

function load(key: string, impersonatingOrgId: string | null): Promise<PermissionSet | null> {
  let hit = cache.get(key);
  if (!hit) {
    hit = apiFetch("/api/session-permissions", { cache: "no-store" }, impersonatingOrgId)
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { permissions: string[] | "all" };
        return body.permissions === "all" ? "all" : new Set(body.permissions);
      })
      .catch(() => null);
    // Lỗi mạng không được nhớ — lần sau thử lại.
    hit.then((v) => {
      if (v === null) cache.delete(key);
    });
    cache.set(key, hit);
  }
  return hit;
}

/**
 * Quyền của người đang đăng nhập, chỉ để ẩn/hiện giao diện. API vẫn tự
 * kiểm quyền — ẩn nút ở đây không thay được chốt chặn phía server.
 *
 * Chưa tải xong: `ready=false`, `can()` trả false (không hiện nhầm rồi giật
 * mất). Tải lỗi: coi như không có quyền nào.
 */
export function usePermissions(userId: string | null | undefined) {
  const impersonatingOrgId = useImpersonatingOrgId();
  const key = `${userId ?? ""}|${impersonatingOrgId ?? ""}`;
  const [state, setState] = useState<{ key: string; perms: PermissionSet | null } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    load(key, impersonatingOrgId).then((perms) => {
      if (alive) setState({ key, perms });
    });
    return () => {
      alive = false;
    };
  }, [key, userId, impersonatingOrgId]);

  const perms = state?.key === key ? state.perms : null;
  const ready = state?.key === key;

  const can = useCallback(
    (anyOf: string[] | string) => {
      if (!perms) return false;
      if (perms === "all") return true;
      const list = typeof anyOf === "string" ? [anyOf] : anyOf;
      return list.some((p) => perms.has(p));
    },
    [perms],
  );

  return { can, ready };
}

/**
 * `can` của trang đang mở — DashboardLayout cấp, thành phần con dùng
 * `useCan()` để ẩn nút thao tác. Ngoài layout: không có quyền nào.
 */
export const PermissionsContext = createContext<(anyOf: string[] | string) => boolean>(
  () => false,
);

export function useCan() {
  return useContext(PermissionsContext);
}
