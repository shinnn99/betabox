"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";

type Variant = "danger" | "warning" | "info";

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: Variant;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const ConfirmCtx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

const VARIANT_STYLE: Record<
  Variant,
  { iconWrap: string; iconColor: string; button: string }
> = {
  danger: {
    iconWrap: "bg-red-50 border-red-100",
    iconColor: "text-red-600",
    button: "bg-red-500 hover:bg-red-600",
  },
  warning: {
    iconWrap: "bg-amber-50 border-amber-100",
    iconColor: "text-amber-600",
    button: "bg-amber-500 hover:bg-amber-600",
  },
  info: {
    iconWrap: "bg-blue-50 border-blue-100",
    iconColor: "text-blue-600",
    button: "bg-blue-500 hover:bg-blue-600",
  },
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  const close = (ok: boolean) => {
    if (pending) {
      pending.resolve(ok);
      setPending(null);
    }
  };

  const variant = pending?.variant ?? "danger";
  const style = VARIANT_STYLE[variant];

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm"
          onClick={() => close(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 flex items-start gap-4">
              <div
                className={`h-11 w-11 rounded-xl border flex items-center justify-center shrink-0 ${style.iconWrap}`}
              >
                <AlertTriangle className={`h-5 w-5 ${style.iconColor}`} />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-slate-800 text-base">{pending.title}</h3>
                <div className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  {pending.message}
                </div>
              </div>
              <button
                onClick={() => close(false)}
                className="h-8 w-8 -mr-1 -mt-1 rounded-lg hover:bg-slate-100 inline-flex items-center justify-center text-slate-400 shrink-0"
                aria-label="Đóng"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-3 bg-slate-50/60 border-t border-slate-100 flex justify-end gap-2">
              <button
                onClick={() => close(false)}
                className="h-9 px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-sm font-medium text-slate-700"
              >
                {pending.cancelLabel ?? "Huỷ"}
              </button>
              <button
                onClick={() => close(true)}
                autoFocus
                className={`h-9 px-4 rounded-xl text-white text-sm font-semibold ${style.button}`}
              >
                {pending.confirmLabel ?? "Đồng ý"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm phải nằm trong <ConfirmProvider>");
  return ctx;
}
