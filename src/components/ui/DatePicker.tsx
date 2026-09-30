"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

export type DateString = string;

interface DatePickerProps {
  value: DateString;
  onChange: (value: DateString) => void;
  min?: DateString;
  max?: DateString;
  placeholder?: string;
  disabled?: boolean;
  /** Dense trigger used inside segmented previous/next date controls. */
  compact?: boolean;
  className?: string;
  ariaLabel?: string;
}

const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

function toDateString(date: Date): DateString {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromDateString(value: DateString): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function displayDate(value: DateString): string {
  const date = fromDateString(value);
  if (!date) return "";
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

function sameDay(left: Date, right: Date): boolean {
  return toDateString(left) === toDateString(right);
}

function monthKey(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth();
}

/**
 * Bộ chọn một ngày dùng chung của hệ thống. Giao diện và cách chọn ngày giữ
 * cùng ngôn ngữ thiết kế với DateRangePicker ở trang Bằng chứng giao hàng,
 * thay cho lịch mặc định khác nhau giữa từng trình duyệt/hệ điều hành.
 */
export default function DatePicker({
  value,
  onChange,
  min = "",
  max = "",
  placeholder = "Chọn ngày",
  disabled = false,
  compact = false,
  className = "",
  ariaLabel = "Chọn ngày",
}: DatePickerProps) {
  const dialogTitleId = useId();
  const initialMonth = useMemo(
    () => startOfMonth(fromDateString(value) ?? new Date()),
    [value],
  );
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(initialMonth);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverRect, setPopoverRect] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
  } | null>(null);

  const minDate = useMemo(() => fromDateString(min), [min]);
  const maxDate = useMemo(() => fromDateString(max), [max]);

  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const gap = 6;
      const viewportPadding = 8;
      const width = Math.min(300, window.innerWidth - viewportPadding * 2);
      const estimatedHeight = 372;
      const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const spaceAbove = rect.top - gap - viewportPadding;
      const openUp = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
      );

      setPopoverRect({
        left,
        width,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
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
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  const pick = useCallback(
    (next: DateString) => {
      if ((min && next < min) || (max && next > max)) return;
      onChange(next);
      close();
      triggerRef.current?.focus();
    },
    [close, max, min, onChange],
  );

  const today = toDateString(new Date());
  const todayAllowed = (!min || today >= min) && (!max || today <= max);
  const previousDisabled = Boolean(
    minDate && monthKey(viewMonth) <= monthKey(minDate),
  );
  const nextDisabled = Boolean(
    maxDate && monthKey(viewMonth) >= monthKey(maxDate),
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setViewMonth(initialMonth);
          setOpen(true);
        }}
        className={
          compact
            ? `h-7 px-1.5 inline-flex items-center gap-1.5 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-100 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${className}`
            : `h-9 px-3 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white text-sm text-slate-700 hover:border-slate-300 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${className}`
        }
      >
        <Calendar className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className={value ? "text-slate-700" : "text-slate-400"}>
          {value ? displayDate(value) : placeholder}
        </span>
      </button>

      {open && popoverRect && typeof window !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-modal="false"
              aria-labelledby={dialogTitleId}
              style={{
                position: "fixed",
                left: popoverRect.left,
                top: popoverRect.top,
                bottom: popoverRect.bottom,
                width: popoverRect.width,
                zIndex: 200,
              }}
              className="rounded-2xl border border-slate-200 bg-white p-3 shadow-xl"
            >
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  disabled={previousDisabled}
                  aria-label="Tháng trước"
                  onClick={() =>
                    setViewMonth(
                      new Date(
                        viewMonth.getFullYear(),
                        viewMonth.getMonth() - 1,
                        1,
                      ),
                    )
                  }
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span
                  id={dialogTitleId}
                  className="text-sm font-semibold text-slate-800"
                >
                  Tháng {viewMonth.getMonth() + 1}, {viewMonth.getFullYear()}
                </span>
                <button
                  type="button"
                  disabled={nextDisabled}
                  aria-label="Tháng sau"
                  onClick={() =>
                    setViewMonth(
                      new Date(
                        viewMonth.getFullYear(),
                        viewMonth.getMonth() + 1,
                        1,
                      ),
                    )
                  }
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-2 grid grid-cols-7 gap-0.5 text-center text-[11px] text-slate-400">
                {WEEKDAYS.map((weekday) => (
                  <span key={weekday} className="py-1">
                    {weekday}
                  </span>
                ))}
              </div>

              <MonthGrid
                month={viewMonth}
                selected={value}
                min={min}
                max={max}
                onPick={pick}
              />

              {todayAllowed && (
                <div className="mt-3 flex justify-end border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    onClick={() => pick(today)}
                    className="h-7 rounded-md border border-slate-100 bg-slate-50 px-2 text-xs text-slate-700 hover:bg-slate-100"
                  >
                    Hôm nay
                  </button>
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function MonthGrid({
  month,
  selected,
  min,
  max,
  onPick,
}: {
  month: Date;
  selected: DateString;
  min: DateString;
  max: DateString;
  onPick: (value: DateString) => void;
}) {
  const first = startOfMonth(month);
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = addDays(first, -mondayOffset);
  const cells = Array.from({ length: 42 }, (_, index) =>
    addDays(gridStart, index),
  );
  const today = new Date();

  return (
    <div className="mt-1 grid grid-cols-7 gap-0.5">
      {cells.map((date) => {
        const dateString = toDateString(date);
        const inMonth = date.getMonth() === month.getMonth();
        const isSelected = dateString === selected;
        const isToday = sameDay(date, today);
        const unavailable =
          Boolean(min && dateString < min) || Boolean(max && dateString > max);

        return (
          <button
            key={dateString}
            type="button"
            disabled={unavailable}
            aria-label={displayDate(dateString)}
            aria-pressed={isSelected}
            onClick={() => onPick(dateString)}
            className={[
              "relative h-8 rounded-md text-xs transition-colors",
              !inMonth ? "text-slate-300" : "text-slate-700",
              !isSelected && !unavailable ? "hover:bg-slate-100" : "",
              isSelected
                ? "bg-emerald-500 font-semibold text-white hover:bg-emerald-600"
                : "",
              isToday && !isSelected
                ? "ring-1 ring-inset ring-emerald-300"
                : "",
              unavailable
                ? "cursor-not-allowed text-slate-200 opacity-60"
                : "",
            ].join(" ")}
          >
            {date.getDate()}
          </button>
        );
      })}
    </div>
  );
}
