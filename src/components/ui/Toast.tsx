"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
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
  error: (message: string) => void;
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, variant: ToastVariant = "info") => {
      const id = Date.now() + Math.random();
      setItems((cur) => [...cur, { id, variant, message }]);
      setTimeout(() => remove(id), 4500);
    },
    [remove]
  );

  const api: ToastApi = {
    show,
    success: (m) => show(m, "success"),
    error: (m) => show(m, "error"),
    info: (m) => show(m, "info"),
  };

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
