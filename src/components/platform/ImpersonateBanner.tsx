import ImpersonateBannerExitButton from "./ImpersonateBannerExitButton";

// ImpersonateBanner — Server component render banner đỏ khi platform admin
// đang impersonate. Server-render mỗi request (không state cache) → orgName
// luôn khớp cookie hiện tại, không nói dối kể cả sau navigation client.
//
// Fixed top, không dismissible. Nút "Thoát impersonate" là client component
// riêng (gọi API DELETE + reload).
export default function ImpersonateBanner({ orgName }: { orgName: string }) {
  return (
    <div className="fixed top-0 left-0 right-0 h-10 z-[60] bg-red-600 text-white px-4 py-2 flex items-center justify-center gap-3 shadow-md">
      <span className="text-sm font-semibold">
        Đang xem tổ chức: <span className="font-bold">{orgName}</span>
      </span>
      <ImpersonateBannerExitButton />
    </div>
  );
}
