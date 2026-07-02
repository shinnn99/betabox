import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";

interface Props {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: "emerald" | "blue" | "amber" | "rose" | "violet";
  delta?: number;
}

const TONE: Record<NonNullable<Props["tone"]>, { bg: string; ring: string; text: string }> = {
  emerald: { bg: "bg-emerald-50", ring: "ring-emerald-100", text: "text-emerald-600" },
  blue: { bg: "bg-sky-50", ring: "ring-sky-100", text: "text-sky-600" },
  amber: { bg: "bg-amber-50", ring: "ring-amber-100", text: "text-amber-600" },
  rose: { bg: "bg-rose-50", ring: "ring-rose-100", text: "text-rose-600" },
  violet: { bg: "bg-violet-50", ring: "ring-violet-100", text: "text-violet-600" },
};

export default function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "emerald",
  delta,
}: Props) {
  const t = TONE[tone];
  const up = (delta ?? 0) >= 0;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-slate-500 uppercase tracking-wide">
            {label}
          </p>
          <p className="text-2xl lg:text-[28px] font-extrabold text-slate-900 mt-1.5 leading-none tracking-tight">
            {value}
          </p>
        </div>
        <div className={`h-10 w-10 rounded-xl flex items-center justify-center ring-1 ${t.bg} ${t.ring}`}>
          <Icon className={`h-5 w-5 ${t.text}`} />
        </div>
      </div>
      {(typeof delta === "number" || hint) && (
        <div className="mt-3 flex items-center gap-2 text-xs">
          {typeof delta === "number" && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-semibold ${
                up
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-rose-50 text-rose-700"
              }`}
            >
              {up ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {up ? "+" : ""}
              {delta}%
            </span>
          )}
          {hint && <span className="text-slate-500 truncate">{hint}</span>}
        </div>
      )}
    </div>
  );
}
