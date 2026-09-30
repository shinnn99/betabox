"use client";

import InfoDot from "./InfoDot";

/**
 * Chú giải biểu đồ có giải thích khi rê chuột.
 *
 * VÌ SAO: nhãn ngắn kiểu "đơn đo được" / "p90" chỉ đủ cho người đã biết chỉ
 * số đó là gì. Người mở báo cáo lần đầu (chủ kho, kế toán) đọc xong vẫn không
 * biết nó đếm cái gì và tại sao lại tách ra. Giải thích phải nằm NGAY ở chỗ
 * đặt câu hỏi, không bắt đi tìm tài liệu.
 *
 * Dấu hiệu rê-được là chấm than bên cạnh (xem InfoDot), không phải gạch chân.
 */
export interface LegendItem {
  /** Class nền của ô màu, ví dụ "bg-emerald-500". */
  swatch: string;
  label: string;
  /** Câu giải thích hiện khi rê chuột. Bắt buộc — nhãn không tự nói đủ. */
  hint: string;
  /** Ô màu vuông (cột) hay tròn (đường). */
  shape?: "square" | "circle";
  /** Viền cho ô màu nhạt, để phân biệt với nền trắng. */
  ring?: string;
}

export default function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className={`h-2.5 w-2.5 shrink-0 ${
              it.shape === "circle" ? "rounded-full" : "rounded-sm"
            } ${it.swatch} ${it.ring ? `ring-1 ${it.ring}` : ""}`}
          />
          <span className="text-slate-600">{it.label}</span>
          <InfoDot hint={it.hint} />
        </span>
      ))}
    </div>
  );
}
