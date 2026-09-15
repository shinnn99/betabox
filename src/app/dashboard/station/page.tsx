import { redirect } from "next/navigation";
import { MonitorPlay } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import StationLivePanel from "@/components/station/StationLivePanel";
import {
  getCurrentUserStation,
  isError,
  requirePermission,
} from "@/lib/supabase/guard";

export const dynamic = "force-dynamic";

export default async function StationLivePage() {
  const ctx = await requirePermission("live.view_station");
  if (isError(ctx)) redirect("/dashboard");

  const station = await getCurrentUserStation();

  return (
    <DashboardLayout
      pageTitle="Màn hình bàn đóng hàng"
      pageSubtitle={station ? station.name : "Tài khoản chưa được gán bàn"}
      pageIcon={MonitorPlay}
    >
      <div className="mx-auto w-full max-w-7xl">
        {station ? (
          <StationLivePanel stationId={station.id} />
        ) : (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-6 py-10 text-center">
            <p className="text-sm font-semibold text-amber-900">
              Tài khoản đóng gói chưa được gán bàn
            </p>
            <p className="mt-1 text-xs text-amber-700">
              Quản trị viên cần chọn bàn cho tài khoản này trong mục Người dùng hệ thống.
            </p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
