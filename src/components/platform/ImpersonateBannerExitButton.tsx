"use client";

import { useState } from "react";
import { LogOut, Loader2 } from "lucide-react";

export default function ImpersonateBannerExitButton() {
  const [loading, setLoading] = useState(false);

  const onExit = async () => {
    setLoading(true);
    try {
      await fetch("/api/platform/impersonate", { method: "DELETE" });
      // Reload → banner biến mất (server không thấy cookie nữa), guard trở
      // về nhánh tenant thường của user platform-admin (không impersonate).
      // Điều hướng về /platform để admin chọn org khác hoặc thoát hẳn.
      window.location.href = "/platform";
    } catch {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={onExit}
      disabled={loading}
      className="h-7 px-3 rounded-lg bg-white/20 hover:bg-white/30 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-60"
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <LogOut className="h-3.5 w-3.5" />
      )}
      Thoát xem tổ chức
    </button>
  );
}
