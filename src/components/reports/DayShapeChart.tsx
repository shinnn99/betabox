"use client";

import { useEffect, useRef, useState } from "react";
import Legend from "./Legend";

export interface HourlyPoint {
  hour: number;
  outbound: number;
  returns: number;
  recording_hours: number;
}

/**
 * "Một ngày ở kho" — cột đơn theo giờ, chồng đơn đi và đơn hoàn, kèm dải nền
 * chỉ giờ ghi hình.
 *
 * VÌ SAO CẦN: biểu đồ theo NGÀY chỉ nói được tổng, không nói được kho dồn
 * việc lúc nào. Số đo Đại Kim 7 ngày: 9h có 99 đơn, 14h có 58, còn hoàn hàng
 * dồn 15–16h. Bố trí người theo tổng ngày là bố trí sai.
 *
 * Dải ghi hình nằm NỀN, không phải đường thứ ba: câu hỏi ở đây là nhị phân —
 * "giờ kho làm việc có camera chạy không" — nên nó là bối cảnh, không phải
 * số để so cao thấp.
 *
 * Đơn đi và kiện hoàn vẽ HAI CỘT CẠNH NHAU, không chồng lên nhau: chồng cột
 * đọc thành một tổng, mà hai luồng này không được cộng gộp (chốt 23/09/2026).
 * Cạnh nhau vẫn thấy được "chiều mới nhận hoàn" — thứ duy nhất cần ở đây.
 */
export default function DayShapeChart({ hourly }: { hourly: HourlyPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 28, left: 40 };

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

  const maxOrders = Math.max(
    1,
    ...hourly.map((h) => Math.max(h.outbound, h.returns)),
  );
  const maxRec = Math.max(0.001, ...hourly.map((h) => h.recording_hours));
  const step = innerW / 24;
  // Hai cột cạnh nhau trong mỗi khung giờ, chừa khe hai bên.
  const pairW = step * 0.66;
  const barW = Math.max(1.5, pairW / 2 - 1);

  const yAt = (v: number) => padding.top + innerH - (v / maxOrders) * innerH;
  const xAt = (hour: number) => padding.left + step * hour + (step - pairW) / 2;

  const ticks = [0, Math.round(maxOrders / 2), maxOrders];

  return (
    <div className="space-y-3">
      <Legend
        items={[
          {
            swatch: "bg-emerald-500",
            label: "Đơn đóng",
            hint: "Đơn đóng quét trong khung giờ đó, cộng dồn mọi ngày. Nhìn cột cao thấp để biết kho dồn việc lúc nào mà bố trí người.",
          },
          {
            swatch: "bg-amber-500",
            label: "Kiện hoàn",
            hint: "Kiện hoàn nhận trong khung giờ đó. Cột riêng cạnh đơn đóng, không chồng lên — hai nghiệp vụ khác nhau.",
          },
          {
            swatch: "bg-sky-100",
            ring: "ring-sky-200",
            label: "Giờ có ghi hình",
            hint: "Nền xanh = camera có ghi giờ đó, càng đậm càng nhiều giờ. Giờ kho làm việc mà nền trắng nghĩa là đơn đó không có video bằng chứng.",
          },
        ]}
      />

      <div ref={ref} className="w-full">
        <svg width={width} height={height} role="img" className="block">
          {/* Nền ghi hình — đậm nhạt theo số giờ ghi được trong khung giờ đó. */}
          {hourly.map((h) => {
            if (h.recording_hours <= 0) return null;
            const opacity = 0.25 + 0.55 * (h.recording_hours / maxRec);
            return (
              <rect
                key={`rec-${h.hour}`}
                x={padding.left + step * h.hour}
                y={padding.top}
                width={step}
                height={innerH}
                fill="rgb(186 230 253)"
                opacity={opacity}
              />
            );
          })}

          {ticks.map((t) => (
            <g key={`tick-${t}`}>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={yAt(t)}
                y2={yAt(t)}
                stroke="rgb(226 232 240)"
                strokeWidth={1}
              />
              <text
                x={padding.left - 8}
                y={yAt(t) + 3}
                fontSize={11}
                textAnchor="end"
                fill="rgb(148 163 184)"
              >
                {t}
              </text>
            </g>
          ))}

          {hourly.map((h) => {
            const outH = (h.outbound / maxOrders) * innerH;
            const retH = (h.returns / maxOrders) * innerH;
            const base = padding.top + innerH;
            return (
              <g key={`bar-${h.hour}`}>
                {h.outbound > 0 && (
                  <rect
                    x={xAt(h.hour)}
                    y={base - outH}
                    width={barW}
                    height={outH}
                    fill="rgb(16 185 129)"
                    rx={2}
                  />
                )}
                {h.returns > 0 && (
                  <rect
                    x={xAt(h.hour) + barW + 2}
                    y={base - retH}
                    width={barW}
                    height={retH}
                    fill="rgb(245 158 11)"
                    rx={2}
                  />
                )}
                <title>
                  {`${String(h.hour).padStart(2, "0")}:00 · Đơn: ${h.outbound} · Hoàn: ${h.returns} · Ghi hình: ${h.recording_hours}h`}
                </title>
              </g>
            );
          })}

          {hourly.map((h) =>
            h.hour % 3 === 0 ? (
              <text
                key={`lbl-${h.hour}`}
                x={padding.left + step * h.hour + step / 2}
                y={padding.top + innerH + 18}
                fontSize={11}
                textAnchor="middle"
                fill="rgb(100 116 139)"
              >
                {String(h.hour).padStart(2, "0")}h
              </text>
            ) : null,
          )}
        </svg>
      </div>
    </div>
  );
}
