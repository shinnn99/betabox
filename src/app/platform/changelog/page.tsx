"use client";

import { Sparkles } from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import ChangelogTimeline from "@/components/changelog/ChangelogTimeline";

/**
 * Nhật ký phiên bản — bản ở platform.
 *
 * Nội dung KHÔNG phụ thuộc tổ chức (sinh từ thư mục `changelog/` lúc build),
 * nên trang này chỉ là khung platform bọc quanh cùng một dòng thời gian.
 * Nội dung sửa ở `changelog/*.md`, không sửa ở đây.
 */
export default function PlatformChangelogPage() {
  return (
    <PlatformLayout
      pageTitle="Nhật ký phiên bản"
      pageSubtitle="Những thay đổi của hệ thống và của máy trạm kho qua từng lần cập nhật"
      pageIcon={Sparkles}
    >
      <ChangelogTimeline />
    </PlatformLayout>
  );
}
