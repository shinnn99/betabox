"use client";

import { useEffect, useRef } from "react";

// ImpersonateWatcher — Đường 3 (UX làm mới tab): phát hiện cookie impersonate
// đổi ở tab khác → reload tab hiện tại. Đóng ca "quay lại tab cũ với cookie
// mới, màn hình vẫn org cũ".
//
// LƯU Ý: đường 3 là UX (giảm cửa sổ nhầm-tay). CƠ CHẾ đóng cửa sổ ghi-nhầm
// về 0 là VẾ 4 ở guard (so x-render-org-id vs org-trong-token → 409).
// Watcher này KHÔNG bảo vệ data — chỉ làm tab tự cập nhật.
//
// Cơ chế:
//   1. visibilitychange (tab thành visible) → fetch check.
//   2. focus (tab được click focus) → fetch check.
//   3. Interval 3s khi tab visible → poll backup.
export default function ImpersonateWatcher({
  renderOrgId,
}: {
  renderOrgId: string;
}) {
  const renderOrgIdRef = useRef(renderOrgId);
  renderOrgIdRef.current = renderOrgId;

  useEffect(() => {
    let stopped = false;

    const check = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/api/platform/current-impersonate-org", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { orgId: string | null };
        const cookieOrgId = data.orgId;
        // Lệch: cookie ≠ org đang render → reload để đồng bộ
        if (cookieOrgId !== renderOrgIdRef.current) {
          window.location.reload();
        }
      } catch {
        // Silent — poll retry lần sau
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    const onFocus = () => check();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    // Interval 3s khi tab visible (backup nếu event miss)
    const intervalId = setInterval(() => {
      if (document.visibilityState === "visible") check();
    }, 3000);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      clearInterval(intervalId);
    };
  }, []);

  return null;
}
