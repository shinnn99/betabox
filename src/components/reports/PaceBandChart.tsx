"use client";

import { useEffect, useRef, useState } from "react";
import Legend from "./Legend";

export interface PacePoint {
  business_date: string;
  valid: number;
  p50_seconds: number | null;
  p90_seconds: number | null;
  measured_orders: number;
}

function dayLabel(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function fmt(seconds: number | null): string {
  if (seconds === null) return "—";
  const t = Math.round(seconds);
  if (t < 60) return `${t}s`;
  return `${Math.floor(t / 60)}m ${t % 60}s`;
}

/**
 * Nhịp đóng hàng theo ngày — dải p50→p90 thay vì một đường trung bình.
 *
 * VÌ SAO: ngày 29/09 ở Đại Kim TB là 58s, nhưng p50=44s và p90=133s. Trung
 * bình nằm lọt giữa và che mất việc cứ 10 đơn thì có 1 đơn mất hơn hai phút.
 * Dải cho thấy cả mức thường gặp lẫn cái đuôi, trên cùng một hình.
 *
 * Ngày không đo được đơn nào (measured_orders = 0) thì KHÔNG vẽ điểm — nối
 * thẳng qua sẽ bịa ra một nhịp chưa từng đo.
 */
export default function PaceBandChart({ daily }: { daily: PacePoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const height = 240;
  const padding = { top: 16, right: 16, bottom: 30, left: 48 };

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

  const maxV = Math.max(
    1,
    ...daily.map((d) => d.p90_seconds ?? 0),
  );
  const step = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const xAt = (i: number) => padding.left + step * i;
  const yAt = (v: number) => padding.top + innerH - (v / maxV) * innerH;

  // Chỉ nối những ngày ĐO ĐƯỢC; ngày trống cắt đoạn để không bịa số.
  const segments: PacePoint[][] = [];
  let current: PacePoint[] = [];
  const indexOf = new Map<PacePoint, number>();
  daily.forEach((d, i) => {
    indexOf.set(d, i);
    if (d.measured_orders > 0 && d.p50_seconds !== null) {
      current.push(d);
    } else if (current.length) {
      segments.push(current);
      current = [];
    }
  });
  if (current.length) segments.push(current);

  const ticks = [0, Math.round(maxV / 2), Math.round(maxV)];

  return (
    <div className="space-y-3">
      <Legend
        items={[
          {
            swatch: "bg-violet-500",
            shape: "circle",
            label: "p50 — mức thường gặp",
            hint: "Nửa số đơn trong ngày nhanh hơn mức này, nửa chậm hơn. Dùng thay trung bình vì trung bình bị vài đơn cá biệt kéo lệch.",
          },
          {
            swatch: "bg-violet-100",
            ring: "ring-violet-200",
            label: "dải p50 → p90",
            hint: "Mép trên là p90: cứ 10 đơn có 1 đơn chậm hơn mức đó. Dải dày là các đơn chênh lệch nhiều, dải mỏng là kho chạy đều tay.",
          },
        ]}
      />

      <div ref={ref} className="w-full">
        <svg width={width} height={height} role="img" className="block">
          {ticks.map((t) => (
            <g key={`t-${t}`}>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={yAt(t)}
                y2={yAt(t)}
                stroke="rgb(241 245 249)"
                strokeWidth={1}
              />
              <text
                x={padding.left - 8}
                y={yAt(t) + 3}
                fontSize={11}
                textAnchor="end"
                fill="rgb(148 163 184)"
              >
                {fmt(t)}
              </text>
            </g>
          ))}

          {segments.map((seg, si) => {
            const idx = (p: PacePoint) => indexOf.get(p) ?? 0;
            const top = seg
              .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(idx(p))} ${yAt(p.p90_seconds ?? 0)}`)
              .join(" ");
            const bottom = [...seg]
              .reverse()
              .map((p) => `L ${xAt(idx(p))} ${yAt(p.p50_seconds ?? 0)}`)
              .join(" ");
            const line = seg
              .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(idx(p))} ${yAt(p.p50_seconds ?? 0)}`)
              .join(" ");
            return (
              <g key={`seg-${si}`}>
                <path d={`${top} ${bottom} Z`} fill="rgb(237 233 254)" opacity={0.9} />
                <path
                  d={line}
                  fill="none"
                  stroke="rgb(139 92 246)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          {daily.map((d, i) =>
            d.measured_orders > 0 && d.p50_seconds !== null ? (
              <g key={`pt-${d.business_date}`}>
                <circle cx={xAt(i)} cy={yAt(d.p50_seconds)} r={3} fill="rgb(139 92 246)" />
                <title>
                  {`${dayLabel(d.business_date)} · p50 ${fmt(d.p50_seconds)} · p90 ${fmt(d.p90_seconds)} · đo trên ${d.measured_orders}/${d.valid} đơn`}
                </title>
              </g>
            ) : null,
          )}

          {daily.map((d, i) => {
            const everyNth = Math.max(1, Math.ceil(daily.length / 12));
            if (i % everyNth !== 0 && i !== daily.length - 1) return null;
            return (
              <text
                key={`l-${d.business_date}`}
                x={xAt(i)}
                y={padding.top + innerH + 18}
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
