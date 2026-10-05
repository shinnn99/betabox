"use client";

import { Video } from "lucide-react";
import Select, { type SelectOption } from "@/components/ui/Select";

export type ClipStatusFilter =
  | "any"
  | "available"
  | "missing"
  | "pending"
  | "failed";

const OPTIONS: SelectOption[] = [
  { value: "any", label: "Tất cả trạng thái" },
  { value: "available", label: "Có clip" },
  { value: "missing", label: "Chưa có clip" },
  { value: "pending", label: "Đang tạo clip" },
  { value: "failed", label: "Clip lỗi" },
];

export default function ClipStatusFilterSelect({
  value,
  onChange,
  className = "",
}: {
  value: ClipStatusFilter;
  onChange: (value: ClipStatusFilter) => void;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onChange={(next) => onChange(next as ClipStatusFilter)}
      options={OPTIONS}
      size="sm"
      ariaLabel="Lọc theo trạng thái clip"
      leadingIcon={<Video className="h-4 w-4" />}
      className={`!w-44 shrink-0 ${className}`}
    />
  );
}
