"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";

// We use plain "YYYY-MM-DD" strings instead of Date objects so the
// picker can hand a stable value to callers without TZ surprises.
// Callers convert to day-start/day-end Date themselves.
export type DateString = string;

interface DateRangePickerProps {
  from: DateString;
  to: DateString;
  onChange: (next: { from: DateString; to: DateString }) => void;
  /** Right-aligned helper text inside trigger, e.g. "Tất cả". */
  placeholder?: string;
  className?: string;
}

const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const MONTH_LABEL = (d: Date) =>
  `Tháng ${d.getMonth() + 1}, ${d.getFullYear()}`;

function todayString(): DateString {
  return toDateString(new Date());
}
function toDateString(d: Date): DateString {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fromDateString(s: DateString): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
// vi-VN short label e.g. "28/06/2026".
function displayDate(s: DateString): string {
  const d = fromDateString(s);
  if (!d) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

export default function DateRangePicker({
  from,
  to,
  onChange,
  placeholder = "Tất cả",
  className = "",
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  // Anchor month controls which month grid is rendered. Defaults to the
  // month containing `from` when reopened, else current month.
  const initialMonth = useMemo(() => {
    const d = fromDateString(from) ?? fromDateString(to) ?? new Date();
    return startOfMonth(d);
  }, [from, to]);
  const [viewMonth, setViewMonth] = useState<Date>(initialMonth);

  // While picking, we track the in-flight selection separately from the
  // committed `from`/`to`. First click sets `pickFrom`; the second click
  // commits the range. Clicking again starts a new range.
  const [pickFrom, setPickFrom] = useState<DateString | null>(null);
  // Hover preview while waiting for the second click. Lets the user see
  // the range they're about to commit before they click.
  const [hover, setHover] = useState<DateString | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverRect, setPopoverRect] = useState<{
    left: number;
    top: number;
  } | null>(null);

  // Reset transient pick state when reopening.
  useEffect(() => {
    if (open) {
      setViewMonth(initialMonth);
      setPickFrom(null);
      setHover(null);
    }
  }, [open, initialMonth]);

  useLayoutEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPopoverRect({
        left: r.left + window.scrollX,
        top: r.bottom + window.scrollY + 6,
      });
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onDayClick = useCallback(
    (s: DateString) => {
      if (!pickFrom) {
        setPickFrom(s);
        return;
      }
      const a = pickFrom;
      const b = s;
      // If the user picks an earlier date second, swap.
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      onChange({ from: lo, to: hi });
      setPickFrom(null);
      setHover(null);
      setOpen(false);
    },
    [pickFrom, onChange],
  );

  const setQuick = useCallback(
    (days: number) => {
      const end = new Date();
      const start = addDays(end, -(days - 1));
      onChange({ from: toDateString(start), to: toDateString(end) });
      setOpen(false);
    },
    [onChange],
  );

  const setToday = useCallback(() => {
    const t = todayString();
    onChange({ from: t, to: t });
    setOpen(false);
  }, [onChange]);

  const clear = useCallback(() => {
    onChange({ from: "", to: "" });
    setOpen(false);
  }, [onChange]);

  // What range to highlight in the grid right now:
  //   * If a pickFrom exists, highlight [pickFrom, hover ?? pickFrom].
  //   * Else, highlight the committed [from, to].
  const activeFrom = pickFrom ?? from;
  const activeTo = pickFrom ? (hover ?? pickFrom) : to;
  // Normalize for compare (swap if user is hovering backwards).
  const [hiLo, hiHi] =
    activeFrom && activeTo
      ? activeFrom <= activeTo
        ? [activeFrom, activeTo]
        : [activeTo, activeFrom]
      : [activeFrom, activeTo];

  const triggerLabel = (() => {
    if (from && to) {
      return from === to
        ? displayDate(from)
        : `${displayDate(from)} → ${displayDate(to)}`;
    }
    if (from) return `Từ ${displayDate(from)}`;
    if (to) return `Đến ${displayDate(to)}`;
    return placeholder;
  })();
  const hasValue = Boolean(from || to);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`h-9 pl-3 pr-2.5 rounded-xl border border-slate-200 bg-white text-sm inline-flex items-center gap-2 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition-colors ${
          hasValue ? "text-slate-800" : "text-slate-400"
        } ${className}`}
      >
        <Calendar className="h-4 w-4 text-slate-400 shrink-0" />
        <span className="truncate">{triggerLabel}</span>
        {hasValue && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                clear();
              }
            }}
            aria-label="Xoá lọc ngày"
            className="ml-1 h-5 w-5 rounded-md inline-flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {open && popoverRect && typeof window !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="Chọn khoảng ngày"
              style={{
                position: "absolute",
                left: popoverRect.left,
                top: popoverRect.top,
                zIndex: 200,
              }}
              className="bg-white rounded-2xl border border-slate-200 shadow-xl p-3 w-[300px]"
            >
              <CalendarHeader
                month={viewMonth}
                onPrev={() =>
                  setViewMonth(
                    new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1),
                  )
                }
                onNext={() =>
                  setViewMonth(
                    new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1),
                  )
                }
              />

              <div className="mt-2 grid grid-cols-7 gap-0.5 text-[11px] text-slate-400 text-center">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="py-1">
                    {w}
                  </span>
                ))}
              </div>

              <MonthGrid
                month={viewMonth}
                from={hiLo}
                to={hiHi}
                onPick={onDayClick}
                onHover={(s) => {
                  if (pickFrom) setHover(s);
                }}
              />

              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-1">
                <div className="flex flex-wrap gap-1">
                  <PresetButton onClick={setToday}>Hôm nay</PresetButton>
                  <PresetButton onClick={() => setQuick(7)}>7 ngày</PresetButton>
                  <PresetButton onClick={() => setQuick(30)}>30 ngày</PresetButton>
                </div>
                <button
                  type="button"
                  onClick={clear}
                  className="px-2 h-7 rounded-md text-xs text-slate-500 hover:bg-slate-100"
                >
                  Xoá
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function CalendarHeader({
  month,
  onPrev,
  onNext,
}: {
  month: Date;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Tháng trước"
        className="h-7 w-7 rounded-md inline-flex items-center justify-center text-slate-500 hover:bg-slate-100"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="text-sm font-semibold text-slate-800">
        {MONTH_LABEL(month)}
      </span>
      <button
        type="button"
        onClick={onNext}
        aria-label="Tháng sau"
        className="h-7 w-7 rounded-md inline-flex items-center justify-center text-slate-500 hover:bg-slate-100"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function MonthGrid({
  month,
  from,
  to,
  onPick,
  onHover,
}: {
  month: Date;
  from: DateString;
  to: DateString;
  onPick: (s: DateString) => void;
  onHover: (s: DateString) => void;
}) {
  // Build a 6-week grid (42 cells) starting on Monday for vi-VN tradition.
  // getDay(): Sun=0..Sat=6. We want Mon=0..Sun=6 for the leading offset.
  const first = startOfMonth(month);
  const weekdayMon0 = (first.getDay() + 6) % 7;
  const cells: Date[] = [];
  const gridStart = addDays(first, -weekdayMon0);
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));

  const today = new Date();

  return (
    <div className="grid grid-cols-7 gap-0.5 mt-1">
      {cells.map((d) => {
        const s = toDateString(d);
        const inMonth = d.getMonth() === month.getMonth();
        const isToday = sameDay(d, today);
        const isFrom = from && s === from;
        const isTo = to && s === to;
        const inRange =
          from && to ? s >= from && s <= to : false;
        const isEdge = isFrom || isTo;

        return (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            onMouseEnter={() => onHover(s)}
            className={[
              "h-8 text-xs rounded-md transition-colors relative",
              !inMonth ? "text-slate-300" : "text-slate-700",
              !isEdge && inRange
                ? "bg-emerald-50 text-emerald-800"
                : !isEdge
                  ? "hover:bg-slate-100"
                  : "",
              isEdge
                ? "bg-emerald-500 text-white hover:bg-emerald-600 font-semibold"
                : "",
              isToday && !isEdge
                ? "ring-1 ring-inset ring-emerald-300"
                : "",
            ].join(" ")}
          >
            {d.getDate()}
          </button>
        );
      })}
    </div>
  );
}

function PresetButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 h-7 rounded-md text-xs text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-100"
    >
      {children}
    </button>
  );
}
