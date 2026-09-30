"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Dấu chấm than cạnh nhãn chỉ số — rê vào hiện giải thích.
 *
 * VÌ SAO KHÔNG DÙNG `title` CỦA TRÌNH DUYỆT (bỏ 30/09/2026): nó trải câu giải
 * thích thành MỘT hàng chạy ngang màn hình, và hiện ở vị trí con trỏ chứ
 * không gắn vào nhãn — nhìn không biết tooltip đang nói về chỉ số nào. Với
 * trang có hàng chục chỉ số cạnh nhau thì đó là lỗi đọc hiểu, không phải
 * chuyện thẩm mỹ. Bản tự dựng chốt bề rộng để chữ xuống dòng, và neo mũi tên
 * ngay dưới chấm than.
 *
 * VÌ SAO PORTAL: tooltip nằm trong <th>/<p> sẽ bị `overflow-x-auto` của bảng
 * cắt mất. Đẩy ra body rồi định vị bằng toạ độ màn hình thì không khối cha
 * nào cắt được.
 *
 * VÌ SAO KHÔNG BỎ HẲN `title`: bàn phím Tab tới vẫn cần đọc được, và trang
 * này có lúc in ra PDF.
 */
export default function InfoDot({ hint }: { hint?: string }) {
  const id = useId();
  const ref = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    arrowLeft: number;
    above: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pad = 8;
      const width = Math.min(280, window.innerWidth - pad * 2);
      const gap = 8;
      // Ước lượng cao: ~16px một dòng, ~38 ký tự mỗi dòng ở bề rộng 280.
      const estimated = Math.ceil((hint?.length ?? 0) / 38) * 17 + 18;
      const above = r.bottom + gap + estimated > window.innerHeight;
      const centre = r.left + r.width / 2;
      const left = Math.min(
        Math.max(pad, centre - width / 2),
        Math.max(pad, window.innerWidth - width - pad),
      );
      setPos({
        left,
        top: above ? r.top - gap : r.bottom + gap,
        arrowLeft: centre - left,
        above,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, hint]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!hint) return null;

  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        role="button"
        aria-label={hint}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="ml-1 inline-flex h-3.5 w-3.5 shrink-0 select-none items-center justify-center rounded-full bg-slate-200 align-middle text-[9px] font-bold leading-none text-slate-500 cursor-help transition-colors hover:bg-slate-400 hover:text-white focus:outline-none focus-visible:bg-slate-400 focus-visible:text-white"
      >
        !
      </span>

      {open && pos && typeof window !== "undefined"
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.above ? undefined : pos.top,
                bottom: pos.above ? window.innerHeight - pos.top : undefined,
                width: Math.min(280, window.innerWidth - 16),
                zIndex: 300,
              }}
              className="pointer-events-none rounded-lg bg-slate-800 px-2.5 py-2 text-[11px] leading-relaxed text-white shadow-lg"
            >
              <span
                style={{
                  left: Math.min(Math.max(10, pos.arrowLeft), 270),
                  [pos.above ? "bottom" : "top"]: -3,
                }}
                className="absolute h-1.5 w-1.5 -translate-x-1/2 rotate-45 bg-slate-800"
              />
              {hint}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
