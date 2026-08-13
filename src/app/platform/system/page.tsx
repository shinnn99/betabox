"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Loader2,
  Moon,
  RefreshCw,
  XCircle,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";

/**
 * Trang tình trạng hạ tầng — 6 ô.
 *
 * VÌ SAO Ở /platform CHỨ KHÔNG /dashboard/system (đề bài ghi /dashboard):
 * middleware chặn đúng người cần xem. src/lib/supabase/proxy.ts:108-149 —
 * platform admin vào /dashboard/* mà không có organization_id trong JWT và
 * không có cookie impersonate thì bị redirect thẳng về /platform. Platform
 * admin KHÔNG có org claim, nên /dashboard/system sẽ không bao giờ mở được
 * cho đúng đối tượng của nó, trong khi admin của khách thuê lại tải được
 * khung trang (API vẫn chặn, nhưng để họ thấy menu là sai chỗ ngay từ đầu).
 * Đặt ở /platform thì cả menu lẫn trang lẫn API cùng một tầng quyền.
 *
 * Trang này CHỦ ĐỘNG là phụ: nó không thay được cảnh báo Lark. Ai mở được
 * trang này nghĩa là đã biết có chuyện. Vì vậy dòng "lần chạy nền gần nhất"
 * ở cuối trang quan trọng ngang 6 ô — nó trả lời "con cảnh báo còn sống
 * không", thứ mà một trang toàn màu xanh không nói được.
 */

type CheckStatus = "ok" | "warn" | "crit" | "unknown" | "skipped";

interface SystemCheck {
  key: string;
  status: CheckStatus;
  value: string;
  message: string;
  unknownKind?: "structural" | "incident";
}

interface StatusResponse {
  checked_at: string;
  worst: CheckStatus;
  checks: SystemCheck[];
  last_background_run: string | null;
}

const LABELS: Record<string, string> = {
  supabase_egress: "Egress Supabase",
  cron_cleanup: "Cron dọn clip",
  agent_heartbeat: "Kết nối agent kho",
  camera_probe: "Camera",
  vps_resources: "Ổ đĩa + RAM VPS",
  warehouse_disk: "Ổ đĩa máy kho",
};

const TONE: Record<CheckStatus, { box: string; chip: string; label: string; Icon: typeof CheckCircle2 }> = {
  ok: {
    box: "border-emerald-100 bg-emerald-50/40",
    chip: "bg-emerald-100 text-emerald-700 border-emerald-200",
    label: "Bình thường",
    Icon: CheckCircle2,
  },
  warn: {
    box: "border-amber-200 bg-amber-50/60",
    chip: "bg-amber-100 text-amber-800 border-amber-200",
    label: "Cảnh báo",
    Icon: AlertTriangle,
  },
  crit: {
    box: "border-red-200 bg-red-50/70",
    chip: "bg-red-100 text-red-700 border-red-200",
    label: "Nghiêm trọng",
    Icon: XCircle,
  },
  unknown: {
    box: "border-slate-200 bg-slate-50/60",
    chip: "bg-slate-100 text-slate-600 border-slate-200",
    label: "Chưa rõ",
    Icon: HelpCircle,
  },
  // Tông chàm nhạt, KHÔNG dùng lại tông xám của "Chưa rõ": hai ô này nói
  // hai chuyện khác nhau (ngoài ca vs mất nguồn dữ liệu) và người trực
  // phải phân biệt được từ xa mà không cần đọc chữ.
  skipped: {
    box: "border-indigo-100 bg-indigo-50/40",
    chip: "bg-indigo-100 text-indigo-700 border-indigo-200",
    label: "Ngoài giờ",
    Icon: Moon,
  },
};

function formatVn(iso: string | null): string {
  if (!iso) return "chưa có";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "chưa có";
  return d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
}

/** "3 phút trước" — cho biết mốc còn tươi hay đã cũ mà không phải trừ tay. */
function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

export default function SystemStatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // KHÔNG setLoading(true) ở đầu hàm: lượt đầu do effect gọi, mà state
  // `loading` đã khởi tạo true rồi — bật lại đồng bộ trong thân effect là
  // một vòng render thừa (react-hooks/set-state-in-effect). Nút bấm tự bật
  // spinner trước khi gọi.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/system/status", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? json.error ?? "Không tải được tình trạng hệ thống.");
        setData(null);
      } else {
        setData(json as StatusResponse);
        setError("");
      }
    } catch (err) {
      // Mạng rớt cũng phải nói ra chứ không để trang treo ở "Đang tải".
      setError(err instanceof Error ? err.message : "Lỗi mạng.");
      setData(null);
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, []);

  // Chỉ tải một lần khi mở + khi bấm nút. KHÔNG tự động lặp: cảnh báo là
  // việc của Lark, trang này không nên tự gọi lại nền vô hạn.
  useEffect(() => {
    void load();
  }, [load]);

  const worstTone = data ? TONE[data.worst] : TONE.unknown;

  return (
    <PlatformLayout
      pageTitle="Tình trạng hệ thống"
      pageSubtitle="Sáu mục kiểm hạ tầng. Cảnh báo thật gửi qua Lark — trang này để xem lại."
      pageIcon={Activity}
    >
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {data && (
            <span
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-xl border text-xs font-semibold ${worstTone.chip}`}
            >
              <worstTone.Icon className="h-3.5 w-3.5" />
              {data.worst === "ok"
                ? "Mọi mục bình thường"
                : data.worst === "skipped"
                  ? "Ngoài giờ vận hành — không mục nào được kiểm"
                  : `Mức cao nhất: ${worstTone.label}`}
            </span>
          )}
          {data && (
            <span className="text-xs text-slate-500">
              Kiểm lúc {formatVn(data.checked_at)}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            disabled={loading}
            className="h-9 px-4 rounded-xl border border-slate-200 bg-white text-slate-600 text-sm font-medium inline-flex items-center gap-2 hover:bg-slate-50 disabled:opacity-60 ml-auto"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Kiểm lại
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="p-10 flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(data?.checks ?? []).map((c) => {
              const tone = TONE[c.status];
              return (
                <div
                  key={c.key}
                  className={`rounded-2xl border p-4 shadow-sm ${tone.box}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-800">
                      {LABELS[c.key] ?? c.key}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 h-6 px-2 rounded-lg border text-[11px] font-semibold shrink-0 ${tone.chip}`}
                    >
                      <tone.Icon className="h-3 w-3" />
                      {tone.label}
                    </span>
                  </div>
                  <div className="mt-2 text-lg font-semibold text-slate-800 break-words">
                    {c.value}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                    {c.message}
                  </p>
                  {c.status === "unknown" && c.unknownKind === "structural" && (
                    // Nói thẳng để không ai nhầm ô xám này với sự cố — và
                    // cũng để không ai tưởng nó đang được theo dõi.
                    <p className="mt-2 text-[11px] text-slate-400">
                      Mục này chưa có nguồn dữ liệu, không gửi cảnh báo.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {data && (
          <div className="text-xs text-slate-500 pt-1">
            Lần tự kiểm nền gần nhất:{" "}
            <span className="font-medium text-slate-700">
              {formatVn(data.last_background_run)}
            </span>{" "}
            {ago(data.last_background_run, now)}
            {" · "}
            systemd timer chạy mỗi 15 phút. Mốc này cũ hơn nhiều thì chính con
            cảnh báo đã chết, không phải hệ đang yên.
          </div>
        )}
      </div>
    </PlatformLayout>
  );
}
