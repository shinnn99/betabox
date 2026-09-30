"use client";

import { useEffect, useRef, useState } from "react";
import Legend from "./Legend";

export interface VolumePoint {
  business_date: string;
  valid: number;
  duplicated: number;
  problems: number;
  capped: number;
}

const TONE = {
  emerald: { solid: "rgb(16 185 129)", soft: "rgb(167 243 208)", chip: "bg-emerald-500", chipSoft: "bg-emerald-200" },
  amber: { solid: "rgb(245 158 11)", soft: "rgb(253 230 138)", chip: "bg-amber-500", chipSoft: "bg-amber-200" },
} as const;

function dayLabel(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/**
 * Sản lượng theo ngày của MỘT luồng. Cột là số đơn, phần capped tô nhạt ngay
 * trong cột đó.
 *
 * CHỒNG CAPPED VÀO CỘT thay vì vẽ đường riêng: capped là một PHẦN của số đơn
 * valid (1.047 trong 3.885 ở Đại Kim), không phải đại lượng song song. Vẽ
 * thành đường riêng sẽ khiến người đọc cộng nhầm thành tổng.
 *
 * KIỆN HOÀN KHÔNG VẼ CHUNG ở đây (chốt 23/09/2026): nó có biểu đồ riêng dùng
 * chính component này với `tone="amber"`. Chồng hai luồng vào một cột là trộn
 * sản lượng của hai nghiệp vụ khác nhau.
 */
export default function VolumeChart({
  daily,
  tone = "emerald",
  unitLabel = "đơn",
  showCapped = true,
}: {
  daily: VolumePoint[];
  tone?: keyof typeof TONE;
  unitLabel?: string;
  /**
   * Luồng hoàn KHÔNG có trạng thái hết-giờ-chờ (chỉ đơn đi mới bị ép thời
   * gian khi thiếu lượt quét kế tiếp). Truyền false để bỏ hẳn nhãn đó khỏi
   * chú giải, thay vì hiện một nhãn luôn bằng 0.
   */
  showCapped?: boolean;
}) {
  const c = TONE[tone];
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const height = 200;
  const padding = { top: 14, right: 16, bottom: 28, left: 40 };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(0, width - padding.left - padding.right);
  const innerH = height - padding.top - padding.bottom;
  const maxV = Math.max(1, ...daily.map((d) => d.valid));
  const step = daily.length > 0 ? innerW / daily.length : 0;
  const barW = Math.max(2, step * 0.6);
  const base = padding.top + innerH;
  const hAt = (v: number) => (v / maxV) * innerH;
  const xAt = (i: number) => padding.left + step * i + (step - barW) / 2;

  const ticks = [0, Math.round(maxV / 2), maxV];

  return (
    <div className="space-y-3">
      <Legend
        items={
          showCapped
            ? [
                {
                  swatch: c.chip,
                  label: `${unitLabel} đo được`,
                  hint: `Số ${unitLabel} đo được thời gian thật nhờ có lượt quét kế tiếp. Chỉ nhóm này được dùng để tính p50/p90.`,
                },
                {
                  swatch: c.chipSoft,
                  label: `${unitLabel} hết giờ chờ`,
                  hint: `Số ${unitLabel} thiếu lượt quét kế tiếp nên hệ ép thời gian thay vì đo thật. Vẫn tính vào sản lượng, chỉ là không dùng đánh giá năng suất.`,
                },
              ]
            : [
                {
                  swatch: c.chip,
                  label: `Số ${unitLabel}`,
                  hint: `Số ${unitLabel} nhận trong ngày, gồm cả kiện bị lưới an toàn bắt ở bàn đóng hàng. Không tính lượt quét lại và lượt quét hỏng.`,
                },
              ]
        }
      />

      <div ref={ref} className="w-full">
        <svg width={width} height={height} role="img" className="block">
          {ticks.map((t) => (
            <g key={`t-${t}`}>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={base - hAt(t)}
                y2={base - hAt(t)}
                stroke="rgb(241 245 249)"
                strokeWidth={1}
              />
              <text
                x={padding.left - 8}
                y={base - hAt(t) + 3}
                fontSize={11}
                textAnchor="end"
                fill="rgb(148 163 184)"
              >
                {t}
              </text>
            </g>
          ))}

          {daily.map((d, i) => {
            const measured = Math.max(0, d.valid - d.capped);
            const hMeasured = hAt(measured);
            const hCapped = hAt(d.capped);
            return (
              <g key={d.business_date}>
                {d.capped > 0 && (
                  <rect
                    x={xAt(i)}
                    y={base - hMeasured - hCapped}
                    width={barW}
                    height={hCapped}
                    fill={c.soft}
                  />
                )}
                {measured > 0 && (
                  <rect
                    x={xAt(i)}
                    y={base - hMeasured}
                    width={barW}
                    height={hMeasured}
                    fill={c.solid}
                    rx={2}
                  />
                )}
                <title>
                  {`${dayLabel(d.business_date)} · ${d.valid} ${unitLabel}${d.capped > 0 ? ` (${d.capped} hết giờ chờ)` : ""} · ${d.duplicated} trùng · ${d.problems} lỗi quét`}
                </title>
              </g>
            );
          })}

          {daily.map((d, i) => {
            const everyNth = Math.max(1, Math.ceil(daily.length / 12));
            if (i % everyNth !== 0 && i !== daily.length - 1) return null;
            return (
              <text
                key={`l-${d.business_date}`}
                x={padding.left + step * i + step / 2}
                y={base + 18}
                fontSize={11}
                textAnchor="middle"
                fill="rgb(100 116 139)"
              >
                {dayLabel(d.business_date)}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
