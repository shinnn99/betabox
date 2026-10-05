/**
 * Bảng Đội agent — /platform/agents (kế hoạch VAN-HANH-NHIEU-KHO, đợt 7).
 * Mỗi dòng một máy kho: phiên bản, ping, camera đang ghi, ổ còn mấy ngày,
 * hàng đợi, lần đọc QR cuối, sự cố mở. Mở một màn hình thấy mọi kho — không
 * phải đóng giả vào từng tổ chức (kế hoạch 6.2).
 *
 * Không giữ trạng thái — dựng và kiểm riêng được.
 */
import Link from "next/link";
import { AlertTriangle, Loader2, Stethoscope } from "lucide-react";
import { ago } from "@/lib/format/time-vn";

export interface FleetAgentView {
  id: string;
  code: string | null;
  name: string | null;
  orgId: string;
  orgName: string;
  status: string;
  lastSeenAt: string | null;
  version: string | null;
  outdated: boolean;
  reportAt: string | null;
  cameras: { declared: number; recording: number | null; notRecording: string[] };
  disk: { freeGb: number; freePct: number; daysLeft: number | null } | null;
  queues: { scans_pending: number | null; clips_pending: number | null; uploads_pending: number | null } | null;
  lastQrSuccessAt: string | null;
  capabilities: string[];
  openIncidents: { crit: number; warn: number };
  latestDiagnostic: {
    id: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    eventName: string | null;
    automatic: boolean;
  } | null;
}

/** Agent coi là "đang sống" nếu ping trong 5 phút — khớp reaper pg_cron. */
export const ONLINE_MS = 5 * 60_000;

type Props = Readonly<{
  agents: FleetAgentView[];
  latestVersion: string;
  now: number;
  busyId: string | null;
  onDiagnose: (agent: FleetAgentView) => void;
  onViewDiagnostics: (agent: FleetAgentView) => void;
}>;

export default function FleetTable({ agents, latestVersion, now, busyId, onDiagnose, onViewDiagnostics }: Props) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Máy kho</th>
              <th className="text-left px-3 py-2 font-medium">Phiên bản</th>
              <th className="text-left px-3 py-2 font-medium">Ping cuối</th>
              <th className="text-left px-3 py-2 font-medium">Camera ghi</th>
              <th className="text-left px-3 py-2 font-medium">Ổ đĩa</th>
              <th className="text-left px-3 py-2 font-medium">Hàng đợi · QR</th>
              <th className="text-left px-3 py-2 font-medium">Sự cố mở</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {agents.length === 0 ? (
              // Bảng trống trơn không chữ bị đọc thành "trang hỏng". Nói rõ là
              // KHÔNG có máy nào, chứ không để người xem tự đoán.
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-500">
                  Chưa có máy kho nào được khai trong hệ thống.
                </td>
              </tr>
            ) : (
              agents.map((a) => (
                <FleetRow key={a.id} a={a} latestVersion={latestVersion} now={now} busy={busyId === a.id} disabled={busyId !== null} onDiagnose={onDiagnose} onViewDiagnostics={onViewDiagnostics} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FleetRow({
  a,
  latestVersion,
  now,
  busy,
  disabled,
  onDiagnose,
  onViewDiagnostics,
}: Readonly<{
  a: FleetAgentView;
  latestVersion: string;
  now: number;
  busy: boolean;
  disabled: boolean;
  onDiagnose: Props["onDiagnose"];
  onViewDiagnostics: Props["onViewDiagnostics"];
}>) {
  const online = a.lastSeenAt !== null && now - Date.parse(a.lastSeenAt) <= ONLINE_MS;
  const canDiagnose = online && a.capabilities.includes("collect_diagnostics");
  return (
    <tr className={a.status === "active" ? "" : "opacity-60"}>
      <td className="px-3 py-2 align-top">
        <p className="font-medium text-slate-800">{a.code ?? "—"}</p>
        <p className="text-[11px] text-slate-400">
          <Link href={`/platform/orgs/${a.orgId}`} className="hover:text-slate-700 hover:underline">
            {a.orgName}
          </Link>
          {a.status === "active" ? "" : ` · ${a.status}`}
        </p>
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {a.version ? (
          <span className={a.outdated ? "text-amber-700 font-medium" : "text-slate-700"}>
            {a.version}
            {a.outdated && ` ⚠ (mới nhất ${latestVersion})`}
          </span>
        ) : (
          <span className="text-amber-700">chưa tự khai (≤ 0.12.x)</span>
        )}
      </td>
      <td className="px-3 py-2 align-top text-xs whitespace-nowrap">
        <span className={online ? "text-emerald-700" : "text-red-600 font-medium"}>
          {a.lastSeenAt ? ago(a.lastSeenAt, now) : "chưa bao giờ"}
        </span>
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {a.cameras.recording === null ? (
          <span className="text-slate-400">{a.cameras.declared} khai · chưa rõ</span>
        ) : (
          <>
            <span className={a.cameras.recording < a.cameras.declared ? "text-red-600 font-medium" : "text-slate-700"}>
              {a.cameras.recording}/{a.cameras.declared}
            </span>
            {a.cameras.notRecording.length > 0 && (
              <p className="text-[11px] text-red-600">không ghi: {a.cameras.notRecording.join(", ")}</p>
            )}
          </>
        )}
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {a.disk ? <DiskCell disk={a.disk} /> : <span className="text-slate-400">—</span>}
      </td>
      <td className="px-3 py-2 align-top text-xs text-slate-600">
        {a.queues ? (
          <p>
            quét chờ gửi: {a.queues.scans_pending ?? "—"}
          </p>
        ) : (
          <p className="text-slate-400">—</p>
        )}
        <p className="text-[11px] text-slate-400">
          QR cuối: {a.lastQrSuccessAt ? ago(a.lastQrSuccessAt, now) : "—"}
        </p>
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {a.openIncidents.crit + a.openIncidents.warn === 0 ? (
          <span className="text-slate-400">0</span>
        ) : (
          // Thấy "3 crit" mà không đi tiếp được là ngõ cụt: link sang trang Sự
          // cố đã lọc sẵn đúng kho của máy này.
          <Link
            href={`/platform/incidents?org=${a.orgId}`}
            className="inline-flex items-center gap-1 hover:underline"
            title={`Xem sự cố đang mở của ${a.orgName}`}
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
            {a.openIncidents.crit > 0 && <span className="text-red-700 font-medium">{a.openIncidents.crit} crit</span>}
            {a.openIncidents.warn > 0 && <span className="text-amber-700">{a.openIncidents.warn} warn</span>}
          </Link>
        )}
      </td>
      <td className="px-3 py-2 align-top text-right">
        {a.latestDiagnostic && (
          <button
            type="button"
            onClick={() => onViewDiagnostics(a)}
            className="mb-1 h-7 px-2 rounded-lg border border-sky-200 bg-sky-50 text-xs text-sky-700 block ml-auto"
            title={a.latestDiagnostic.eventName ?? "Chẩn đoán gần nhất"}
          >
            {a.latestDiagnostic.automatic ? "Xem quét sau lỗi" : "Xem lần quét trước"}
          </button>
        )}
        <button
          type="button"
          disabled={!canDiagnose || disabled}
          title={
            canDiagnose
              ? "Thu chẩn đoán từ máy kho"
              : online
                ? "Máy kho chạy bản chưa biết lệnh này (cần 0.13.0)"
                : "Máy kho không online — lệnh chỉ chạy khi agent còn sống"
          }
          onClick={() => onDiagnose(a)}
          className="h-7 px-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-700 inline-flex items-center gap-1 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Stethoscope className="h-3.5 w-3.5" />}
          {" "}Chẩn đoán
        </button>
      </td>
    </tr>
  );
}

function DiskCell({ disk }: Readonly<{ disk: NonNullable<FleetAgentView["disk"]> }>) {
  let tone = "text-slate-700";
  if ((disk.daysLeft !== null && disk.daysLeft < 3) || disk.freePct < 3) tone = "text-red-600 font-medium";
  else if ((disk.daysLeft !== null && disk.daysLeft < 7) || disk.freePct < 10) tone = "text-amber-700 font-medium";
  return (
    <>
      <p className={tone}>{disk.daysLeft === null ? "chưa đủ số liệu" : `còn ~${disk.daysLeft} ngày`}</p>
      <p className="text-[11px] text-slate-400">
        {disk.freeGb} GB trống ({disk.freePct}%)
      </p>
    </>
  );
}
