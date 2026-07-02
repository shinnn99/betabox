import { NextResponse } from "next/server";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  listCandidateSubnets,
  rankCandidateSubnets,
  scanForCameras,
  validatePrivateCidr,
  type CandidateSubnet,
  type DiscoveredDevice,
  type ScanMode,
} from "@/lib/camera/discovery";

export const runtime = "nodejs";
// Quick mode runs ~3-5s, full mode ~15-30s. Make sure Vercel/edge don't
// chop us off mid-scan when a customer eventually deploys the warehouse-
// agent or runs this directly on the kho machine.
export const maxDuration = 60;

// Camera auto-discovery on the local LAN.
//
// SaaS note: when this product moves to a hosted topology, this route
// stops being useful from the cloud — the backend won't be able to see
// the customer's private subnets. The intended migration is to move
// `scanForCameras` into the on-prem warehouse-agent and have this route
// proxy to it. Keep the request/response shape stable to ease that move.

interface DiscoverBody {
  cidr?: string;
  // Either a single CIDR (legacy) or a list of subnets to scan together.
  subnets?: string[];
  // "quick" (default): ONVIF + minimal TCP. Sub-5s.
  // "full": expanded ports + HTTP probe on every web host, across all
  // detected private subnets if `subnets` isn't given.
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

async function fetchExistingCameraIps(orgId: string): Promise<string[]> {
  try {
    const admin = createAdminClient();
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

async function handle(req: Request): Promise<Response> {
  const ctx = await requirePermission("camera.view");
  if (isError(ctx)) return ctx;

  const body = await readBody(req);
  const url = new URL(req.url);
  const requestedCidr = body.cidr ?? url.searchParams.get("cidr") ?? undefined;
  const requestedMode =
    body.mode ?? (url.searchParams.get("mode") as ScanMode | null) ?? undefined;
  const mode: ScanMode = requestedMode === "full" ? "full" : "quick";

  const existingIps = await fetchExistingCameraIps(ctx.organizationId);
  const candidates: CandidateSubnet[] = listCandidateSubnets();
  const ranked = rankCandidateSubnets(candidates, existingIps);

  // Decide which subnets to scan.
  //   - explicit `subnets` array wins
  //   - else single `cidr` for back-compat
  //   - else: in `full` mode we scan ALL detected private subnets, in
  //     `quick` mode just the top-ranked one (keeps the 3-5s budget).
  let subnets: string[] = [];
  if (body.subnets && body.subnets.length > 0) {
    subnets = body.subnets;
  } else if (requestedCidr) {
    subnets = [requestedCidr];
  } else if (mode === "full") {
    subnets = ranked.map((c) => c.cidr);
  } else if (ranked.length > 0) {
    subnets = [ranked[0].cidr];
  }

  if (subnets.length === 0) {
    return NextResponse.json(
      {
        error: "no_private_subnet",
        message:
          "Không phát hiện được mạng nội bộ trên máy chủ. Hãy nhập subnet thủ công (ví dụ 192.168.22.0/24).",
        available_subnets: ranked,
        scan_mode: mode,
      },
      { status: 400 },
    );
  }

  for (const s of subnets) {
    if (!validatePrivateCidr(s)) {
      return NextResponse.json(
        {
          error: "invalid_subnet",
          message:
            "Chỉ hỗ trợ subnet nội bộ (10.x, 172.16-31.x, 192.168.x) với mask /24 hoặc nhỏ hơn.",
          available_subnets: ranked,
          scan_mode: mode,
        },
        { status: 400 },
      );
    }
  }

  console.log(
    `[cameras.discover] org=${ctx.organizationId} mode=${mode} ` +
      `request_cidr=${requestedCidr ?? "-"} subnets=${subnets.join("|")} ` +
      `candidates=${ranked.map((c) => c.cidr).join("|")}`,
  );

  try {
    const result = await scanForCameras({ subnets, mode });
    const existingIpSet = new Set(existingIps);
    const devices = result.devices.map((d) => ({
      ...d,
      already_added: existingIpSet.has(d.ip),
    })) as Array<DiscoveredDevice & { already_added: boolean }>;

    console.log(
      `[cameras.discover] org=${ctx.organizationId} mode=${mode} ` +
        `subnets_scanned=${result.scanned_subnets.length} devices=${devices.length} ` +
        `already_added=${devices.filter((d) => d.already_added).length} ` +
        `onvif=${devices.filter((d) => d.onvif_detected).length}`,
    );

    return NextResponse.json({
      scan_mode: result.scan_mode,
      scanned_subnets: result.scanned_subnets,
      // Back-compat: legacy clients read `selected_subnet` / `subnet`.
      selected_subnet: result.scanned_subnets[0] ?? subnets[0],
      subnet: result.scanned_subnets[0] ?? subnets[0],
      available_subnets: ranked,
      devices,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "scan_failed",
        message: (err as Error).message,
        available_subnets: ranked,
        scan_mode: mode,
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
