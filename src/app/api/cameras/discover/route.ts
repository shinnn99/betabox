import { NextResponse } from "next/server";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAgentLiveness } from "@/lib/watch/agent-liveness";
import { enqueueDiscoverLan } from "@/lib/agent-commands/enqueue";
import {
  validatePrivateCidr,
  type CandidateSubnet,
  type DiscoveredDevice,
  type ScanMode,
} from "@/lib/camera/discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Camera auto-discovery, phiên bản SaaS.
//
// Trước 2026-07-08: route tự chạy `scanForCameras()` trên server Next.js.
// Ok khi server nằm cùng LAN với camera; sai trên Vercel (POP APAC không
// thấy 192.168.x của kho) → `listCandidateSubnets()` rỗng → luôn 400
// "no_private_subnet". Đây là kiến trúc đã note ở comment cũ (đã xoá).
//
// Từ 2026-07-08: route chuyển sang command-queue. Cloud không tự quét,
// chỉ enqueue một `discover_lan` command; agent trong kho poll job, chạy
// scan local, callback qua `/api/agent/command-result`. UI POST để enqueue
// rồi GET với `command_id` để poll kết quả.
//
// Shape response HAI verb — giữ y hệt DiscoverResponse cũ ở kết quả để
// UI không cần đổi logic render, chỉ đổi cách lấy dữ liệu.

interface DiscoverBody {
  cidr?: string;
  subnets?: string[];
  mode?: ScanMode;
}

async function readBody(req: Request): Promise<DiscoverBody> {
  if (req.method !== "POST") return {};
  try {
    const json = (await req.json()) as DiscoverBody | null;
    return json ?? {};
  } catch {
    return {};
  }
}

// POST: enqueue command; trả command_id để UI poll.
export async function POST(req: Request) {
  const ctx = await requirePermission("camera.view");
  if (isError(ctx)) return ctx;

  const body = await readBody(req);
  const url = new URL(req.url);
  const requestedCidr = body.cidr ?? url.searchParams.get("cidr") ?? undefined;
  const requestedMode =
    body.mode ?? (url.searchParams.get("mode") as ScanMode | null) ?? undefined;
  const mode: ScanMode = requestedMode === "full" ? "full" : "quick";

  // Validate subnets trước khi enqueue (fail-fast, không sinh row rác).
  const explicitSubnets: string[] | null =
    body.subnets && body.subnets.length > 0
      ? body.subnets
      : requestedCidr
        ? [requestedCidr]
        : null;
  if (explicitSubnets) {
    for (const s of explicitSubnets) {
      if (!validatePrivateCidr(s)) {
        return NextResponse.json(
          {
            error: "invalid_subnet",
            message:
              "Chỉ hỗ trợ subnet nội bộ (10.x, 172.16-31.x, 192.168.x) với mask /24 hoặc nhỏ hơn.",
          },
          { status: 400 },
        );
      }
    }
  }

  const admin = createAdminClient();

  // Chọn agent để enqueue: model per-org 1 agent hiện tại
  // (xem readAgentLiveness). Multi-warehouse là cọc riêng — cùng sửa
  // helper agent-liveness khi mở kho thứ 2, không tách nhánh ở đây.
  const liveness = await readAgentLiveness(admin, ctx.organizationId);
  if (!liveness.agent_id) {
    return NextResponse.json(
      {
        error: "no_agent_online",
        message:
          "Không có agent kho online. Cài agent trên máy chủ trong kho, hoặc dùng Thêm thủ công.",
      },
      { status: 400 },
    );
  }
  if (liveness.is_offline) {
    return NextResponse.json(
      {
        error: "agent_offline",
        message: `Agent kho hiện offline (${liveness.offline_duration_seconds}s không heartbeat). Kiểm tra máy chủ trong kho hoặc dùng Thêm thủ công.`,
      },
      { status: 400 },
    );
  }

  console.log(
    `[cameras.discover.enqueue] org=${ctx.organizationId} agent=${liveness.agent_id} ` +
      `mode=${mode} request_cidr=${requestedCidr ?? "-"} ` +
      `explicit_subnets=${explicitSubnets?.join("|") ?? "auto"}`,
  );

  try {
    const { command_id } = await enqueueDiscoverLan({
      organizationId: ctx.organizationId,
      agentId: liveness.agent_id,
      mode,
      subnets: explicitSubnets,
    });
    return NextResponse.json({
      command_id,
      agent_id: liveness.agent_id,
      status: "pending",
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "enqueue_failed",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}

// GET: poll kết quả command. UI gọi mỗi ~1s.
// Trả 3 state: pending (chưa xong), done (kèm result), failed (kèm error).
export async function GET(req: Request) {
  const ctx = await requirePermission("camera.view");
  if (isError(ctx)) return ctx;

  const url = new URL(req.url);
  const commandId = url.searchParams.get("command_id");
  if (!commandId) {
    return NextResponse.json(
      { error: "command_id_required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: cmd, error } = await admin
    .from("agent_commands")
    .select("id, status, type, result, error, organization_id")
    .eq("id", commandId)
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: "lookup_failed", message: error.message },
      { status: 500 },
    );
  }
  if (!cmd) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Chặn cross-tenant: user org A không đọc được command org B.
  if (cmd.organization_id !== ctx.organizationId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (cmd.type !== "discover_lan") {
    return NextResponse.json({ error: "wrong_type" }, { status: 400 });
  }

  if (cmd.status === "pending" || cmd.status === "taken") {
    return NextResponse.json({ status: "pending" });
  }
  if (cmd.status === "failed") {
    return NextResponse.json({
      status: "failed",
      error: (cmd.error as string | null) ?? "unknown_error",
      message:
        (cmd.error as string | null) ??
        "Quét mạng thất bại. Thử lại hoặc dùng Thêm thủ công.",
    });
  }
  if (cmd.status !== "done") {
    return NextResponse.json({
      status: "failed",
      error: `unexpected_status:${cmd.status}`,
      message: "Trạng thái quét không xác định. Thử lại.",
    });
  }

  const result = (cmd.result ?? {}) as {
    scan_mode?: ScanMode;
    scanned_subnets?: string[];
    available_subnets?: CandidateSubnet[];
    devices?: DiscoveredDevice[];
  };

  // Enrich already_added dựa trên cameras hiện có của org — làm ở
  // cloud (không phải agent) để agent không cần biết bảng cameras.
  const devices = result.devices ?? [];
  const existingIps = await fetchExistingCameraIps(admin, ctx.organizationId);
  const existingSet = new Set(existingIps);
  const enrichedDevices = devices.map((d) => ({
    ...d,
    already_added: existingSet.has(d.ip),
  }));

  const scanned = result.scanned_subnets ?? [];
  return NextResponse.json({
    status: "done",
    scan_mode: result.scan_mode ?? "quick",
    scanned_subnets: scanned,
    // Back-compat với UI cũ: field selected_subnet + subnet.
    selected_subnet: scanned[0] ?? "",
    subnet: scanned[0] ?? "",
    available_subnets: result.available_subnets ?? [],
    devices: enrichedDevices,
  });
}

async function fetchExistingCameraIps(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<string[]> {
  try {
    const { data } = await admin
      .from("cameras")
      .select("ip")
      .eq("organization_id", orgId);
    return (data ?? [])
      .map((r) => (r as { ip: string | null }).ip)
      .filter((ip): ip is string => typeof ip === "string" && ip.length > 0);
  } catch {
    return [];
  }
}
