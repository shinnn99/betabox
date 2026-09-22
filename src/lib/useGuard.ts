"use client";

import { useCallback } from "react";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "./useSession";
import { usePermissions } from "./usePermissions";

/**
 * Chặn thao tác NGAY TỪ NÚT: không có quyền thì bấm vào chỉ báo "Bạn không
 * có quyền …" — không mở form, không gửi request. Tuyệt đối không để người
 * dùng điền form xong mới nhận "thất bại" từ API (chủ dự án 22/09/2026).
 *
 * Dùng cho mọi nút ghi dữ liệu:
 *   const { guard, can } = usePageGuard();
 *   <button onClick={guard(can("staff.create"), "thêm nhân viên", () => setShowCreate(true))}
 *     className={deniedClass(can("staff.create"))} />
 *
 * Quyền chưa tải xong thì bấm không làm gì (tránh báo nhầm "không có quyền"
 * trong giây đầu mở trang). API vẫn tự kiểm quyền — đây là lớp giao diện.
 */
export function usePageGuard() {
  const { session } = useSession();
  const { can, ready } = usePermissions(session?.userId);
  const toast = useToast();

  const guard = useCallback(
    <A extends unknown[]>(allowed: boolean, action: string, fn: (...args: A) => void) =>
      (...args: A) => {
        if (!ready) return;
        if (!allowed) {
          toast.error(`Bạn không có quyền ${action}.`);
          return;
        }
        fn(...args);
      },
    [ready, toast],
  );

  return { can, ready, guard, session };
}

/** Nút không có quyền: vẫn hiện (để bấm vào nhận thông báo) nhưng mờ đi. */
export function deniedClass(allowed: boolean): string {
  return allowed ? "" : " opacity-50 cursor-not-allowed";
}
