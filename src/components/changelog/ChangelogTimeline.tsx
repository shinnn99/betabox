"use client";

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  RELEASES,
  badgeOf,
  scaleOf,
  type ChangeTag,
  type Release,
} from "@/lib/changelog/releases";

/**
 * Dòng thời gian các lần cập nhật — phần thân dùng chung cho cả trang
 * platform và (trước đây) trang kho.
 *
 * Tách ra khỏi trang vì nội dung KHÔNG phụ thuộc tổ chức: dữ liệu sinh từ
 * thư mục `changelog/` lúc build, mọi nơi đọc cùng một bản. Chỉ khung layout
 * bao ngoài là khác nhau.
 *
 * Phân loại lớn/nhỏ theo chốt của chủ dự án 24/09/2026: đổi cách vận hành
 * hoặc máy kho nhảy số giữa (0.8 → 0.9) là LỚN; chỉ nhảy số cuối
 * (0.8.1 → 0.8.2) là NHỎ.
 */

const TAG_TONE: Record<ChangeTag, string> = {
  "Mới": "bg-rose-50 text-rose-600 border-rose-100",
  "Sửa lỗi": "bg-emerald-50 text-emerald-700 border-emerald-100",
  "Cải tiến": "bg-sky-50 text-sky-700 border-sky-100",
};

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

type Filter = "all" | "lon";

export default function ChangelogTimeline() {
  const [filter, setFilter] = useState<Filter>("all");

  const shown = useMemo(
    () => (filter === "all" ? RELEASES : RELEASES.filter((r) => scaleOf(r) === "lon")),
    [filter],
  );
  const bigCount = useMemo(
    () => RELEASES.filter((r) => scaleOf(r) === "lon").length,
    [],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
          Tất cả ({RELEASES.length})
        </FilterButton>
        <FilterButton active={filter === "lon"} onClick={() => setFilter("lon")}>
          Thay đổi lớn ({bigCount})
        </FilterButton>
        <p className="text-xs text-slate-500 ml-auto">
          Thay đổi lớn = đổi cách vận hành, hoặc máy kho nhảy số giữa (0.8 → 0.9)
        </p>
      </div>

      <ol className="relative border-l border-slate-200 ml-2 space-y-8">
        {shown.map((release) => (
          <ReleaseRow
            key={`${release.date}-${badgeOf(release)}-${release.title}`}
            release={release}
          />
        ))}
      </ol>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 px-3 rounded-xl text-xs font-semibold border transition ${
        active
          ? "bg-slate-900 text-white border-slate-900"
          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function ReleaseRow({ release }: { release: Release }) {
  const big = scaleOf(release) === "lon";
  return (
    <li className="ml-6">
      <span
        className={`absolute -left-[7px] flex items-center justify-center rounded-full ring-4 ring-white ${
          big ? "h-3.5 w-3.5 bg-rose-500 -ml-[1px]" : "h-2.5 w-2.5 bg-slate-300"
        }`}
        aria-hidden
      />

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span
          className={`inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-md border ${
            big
              ? "bg-rose-50 text-rose-600 border-rose-100"
              : "bg-slate-100 text-slate-600 border-slate-200"
          }`}
        >
          {badgeOf(release)}
        </span>
        <h3 className="text-base font-bold text-slate-900">{release.title}</h3>
        <span className="text-sm text-slate-400">· {formatDate(release.date)}</span>
        {big && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
            <Sparkles className="h-3 w-3" />
            Thay đổi lớn
          </span>
        )}
      </div>

      <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{release.summary}</p>

      <div className="mt-3 space-y-2.5">
        {release.items.map((item) => (
          <div
            key={item.title}
            className="rounded-xl border border-slate-100 bg-white p-3.5 shadow-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border ${TAG_TONE[item.tag]}`}
              >
                {item.tag}
              </span>
              <p className="text-sm font-semibold text-slate-800">{item.title}</p>
            </div>
            <p className="mt-1 text-[13px] text-slate-600 leading-relaxed">{item.detail}</p>
          </div>
        ))}
      </div>
    </li>
  );
}
