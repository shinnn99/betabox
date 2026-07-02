"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Optional secondary text rendered under label (e.g. description). */
  hint?: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** "md" = h-10 (default, matches inputs), "sm" = h-9. */
  size?: "sm" | "md";
  /** Optional label rendered above the trigger (used outside <Field>). */
  ariaLabel?: string;
}

const SIZE_CLASS: Record<NonNullable<SelectProps["size"]>, string> = {
  sm: "h-9",
  md: "h-10",
};

/**
 * Accessible single-select dropdown. Drop-in replacement for <select>: same
 * value/onChange contract, no extra wiring. Renders the menu in a portal so
 * it isn't clipped by scrollable modals.
 */
export default function Select({
  value,
  onChange,
  options,
  placeholder = "Chọn...",
  disabled = false,
  className = "",
  size = "md",
  ariaLabel,
}: SelectProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverRect, setPopoverRect] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  const openMenu = useCallback(() => {
    if (disabled) return;
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [disabled, selectedIndex]);

  const closeMenu = useCallback(() => setOpen(false), []);

  // Position the portal popover beneath the trigger and keep it in sync
  // with scroll / resize.
  useLayoutEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPopoverRect({
        left: r.left + window.scrollX,
        top: r.bottom + window.scrollY + 4,
        width: r.width,
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

  // Outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closeMenu]);

  const moveHighlight = useCallback(
    (dir: 1 | -1) => {
      if (options.length === 0) return;
      let idx = highlight;
      for (let i = 0; i < options.length; i++) {
        idx = (idx + dir + options.length) % options.length;
        if (!options[idx].disabled) break;
      }
      setHighlight(idx);
    },
    [highlight, options],
  );

  const handleTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      moveHighlight(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const opt = options[highlight];
      if (opt && !opt.disabled) {
        onChange(opt.value);
        closeMenu();
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      closeMenu();
    }
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKey}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        className={`w-full ${SIZE_CLASS[size]} pl-3 pr-9 rounded-xl border border-slate-200 bg-white text-left text-sm text-slate-800 inline-flex items-center justify-between gap-2 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition-colors relative ${
          disabled ? "opacity-60 cursor-not-allowed bg-slate-50" : "cursor-pointer"
        } ${className}`}
      >
        <span
          className={`truncate ${
            selectedOption ? "text-slate-800" : "text-slate-400"
          }`}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={`absolute right-3 h-4 w-4 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && popoverRect && typeof window !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              role="listbox"
              id={listboxId}
              style={{
                position: "absolute",
                left: popoverRect.left,
                top: popoverRect.top,
                width: popoverRect.width,
                zIndex: 200,
              }}
              className="bg-white rounded-xl border border-slate-200 shadow-lg max-h-72 overflow-y-auto py-1"
            >
              {options.length === 0 ? (
                <p className="px-3 py-2 text-xs text-slate-400">
                  Không có lựa chọn.
                </p>
              ) : (
                options.map((o, i) => {
                  const isSelected = o.value === value;
                  const isHighlighted = i === highlight;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={o.disabled}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => {
                        if (o.disabled) return;
                        onChange(o.value);
                        closeMenu();
                        triggerRef.current?.focus();
                      }}
                      className={`w-full px-3 py-2 text-sm text-left flex items-start gap-2 transition-colors ${
                        o.disabled
                          ? "text-slate-300 cursor-not-allowed"
                          : isHighlighted
                            ? "bg-emerald-50 text-slate-900"
                            : "text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">{o.label}</span>
                        {o.hint && (
                          <span className="block text-[11px] text-slate-500 truncate">
                            {o.hint}
                          </span>
                        )}
                      </span>
                      {isSelected && (
                        <Check className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                      )}
                    </button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
