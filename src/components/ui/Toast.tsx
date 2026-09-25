"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastVariant = "success" | "error" | "info";

interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

interface ToastApi {
  show: (message: string, variant?: ToastVariant) => void;
  success: (message: string) => void;
  /**
   * Nhận `unknown` có chủ đích: chỗ gọi thường truyền thẳng `data.message ??
   * data.error` từ response API, mà giá trị đó có thể là object (xem toText).
   * Ép kiểu `string` ở đây chỉ làm TypeScript im lặng chứ không chặn được
   * object lọt vào lúc chạy — nhận unknown rồi chuẩn hoá mới là chặn thật.
   */
  error: (message: unknown) => void;
  info: (message: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const VARIANT_STYLE: Record<
  ToastVariant,
  { bg: string; border: string; iconColor: string; Icon: typeof CheckCircle2 }
> = {
  success: {
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    iconColor: "text-emerald-600",
    Icon: CheckCircle2,
  },
  error: {
    bg: "bg-red-50",
    border: "border-red-200",
    iconColor: "text-red-600",
    Icon: AlertCircle,
  },
  info: {
    bg: "bg-blue-50",
    border: "border-blue-200",
    iconColor: "text-blue-600",
    Icon: Info,
  },
};

// ============================================================================
// toText — không bao giờ để toast hiện ô rỗng "{}".
//
// Cắn 2026-09-25 (trang Người dùng hệ thống): route trả `{ error: <AuthError> }`.
// `message` của Error là NON-ENUMERABLE nên JSON.stringify làm rụng nó, body
// tới client chỉ còn `{name, status, code}`. Client làm
// `data.message ?? data.error` — `data.message` undefined, rơi sang `data.error`
// vốn là OBJECT, mà `??` chấp nhận object → object lọt vào toast → React in "{}".
// Người dùng thấy ô đỏ rỗng, lỗi thật (khoá ngoại chặn xoá) bị nuốt sạch.
//
// Chặn tại đây vì đây là CỬA CHUNG: mọi trang gọi toast đều đi qua, thay vì
// vá `?? ` ở từng chỗ gọi rồi lần sau lại sót.
// ============================================================================
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    // Dạng lỗi API hay gặp: { message } hoặc { error } — moi chuỗi ra dùng.
    const o = value as Record<string, unknown>;
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.error === "string" && o.error) return o.error;
    // Còn lại: không đoán bừa, nhưng PHẢI nói được điều gì đó hữu ích.
    console.error("[toast] nhận giá trị không phải chuỗi:", value);
    return "Thao tác thất bại — xem Console để biết chi tiết.";
  }
  if (value === null || value === undefined) return "Thao tác thất bại.";
  return String(value);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: unknown, variant: ToastVariant = "info") => {
      const id = Date.now() + Math.random();
      setItems((cur) => [...cur, { id, variant, message: toText(message) }]);
      setTimeout(() => remove(id), 4500);
    },
    [remove]
  );

  // useMemo giữ ref api stable qua re-render — nếu không, mọi consumer dùng
  // useToast() làm deps của useCallback/useEffect sẽ trigger loop khi Provider
  // re-render (2026-07-24 bug: warehouse-config spam 8 toast "Cannot coerce"
  // vì loadRetention useCallback([toast]) recreated mỗi render).
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m) => show(m, "success"),
      error: (m) => show(m, "error"),
      info: (m) => show(m, "info"),
    }),
    [show]
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="fixed top-4 right-4 z-[110] flex flex-col gap-2 max-w-sm pointer-events-none">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastView({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const [enter, setEnter] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEnter(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const s = VARIANT_STYLE[item.variant];
  const Icon = s.Icon;
  return (
    <div
      className={`pointer-events-auto rounded-xl border ${s.border} ${s.bg} shadow-lg px-3.5 py-3 flex items-start gap-2.5 transition-all duration-200 ${
        enter ? "opacity-100 translate-x-0" : "opacity-0 translate-x-2"
      }`}
    >
      <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${s.iconColor}`} />
      <p className="flex-1 text-sm text-slate-800 leading-snug">{item.message}</p>
      <button
        onClick={onClose}
        className="h-6 w-6 -m-1 rounded hover:bg-black/5 inline-flex items-center justify-center text-slate-400 shrink-0"
        aria-label="Đóng"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast phải nằm trong <ToastProvider>");
  return ctx;
}
