// Gate 2 — Verify RLS cross-tenant TỔNG THỂ trước mở khách (V6 signup).
//
// Chạy: node --experimental-strip-types --env-file=.env.local scripts/verify-rls-cross-tenant.ts
//
// Cứng suốt loạt:
// - FULL 22 bảng org-scoped, KHÔNG subset "đại diện" (bẫy A2 đã bác — bảng
//   role-check khác pattern, subset bỏ sót lỗ đúng chỗ khác-pattern).
// - Verify bằng ID row, KHÔNG count (count không phân biệt "row A đúng" vs
//   "row B leak" — cả hai count=1).
// - Seed-fail → severity UNVERIFIED, KHÔNG pass-vacuously (bảng không seed
//   được → query 0 row → đừng tưởng kín).
// - Guard "org lạ → refuse": trước seed, DB chỉ được có ≤ 1 org (Betacom
//   Demo). Sau seed, ≤ 3 org (Betacom + A + B). Nếu vượt → có org khách, dừng.
// - Cleanup theo FK reverse order, verify cleanup sạch.
//
// Ba severity:
// - PASS: seed OK + verify id đúng (nửa-dương thấy row mình + nửa-âm không thấy row kia).
// - LEAK: seed OK nhưng verify id sai (thấy row org khác) — lỗ RLS, dừng-đỏ chi tiết.
// - UNVERIFIED: seed fail — không kết luận được, sửa seed rồi chạy lại.
//
// "22/22 xanh" = 22 bảng PASS, 0 LEAK, 0 UNVERIFIED. Chỉ khi vậy mới mở V6.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { signOrgContext } from "../src/lib/platform/internal-headers-core.ts";
import { randomUUID, randomBytes } from "crypto";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !ANON || !SERVICE) {
  console.error("Missing SUPABASE env vars");
  process.exit(2);
}

const admin = createClient(SUPA_URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ============================================================================
// Colors + logging
// ============================================================================
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function pass(msg: string) {
  console.log(`  ${C.green}✓${C.reset} ${msg}`);
}
function fail(msg: string) {
  console.log(`  ${C.red}✗ LEAK${C.reset} ${msg}`);
}
function unver(msg: string) {
  console.log(`  ${C.yellow}⚠ UNVERIFIED${C.reset} ${msg}`);
}
function info(msg: string) {
  console.log(`  ${C.gray}${msg}${C.reset}`);
}
function section(title: string) {
  console.log(`\n${C.bold}${C.cyan}━━━ ${title}${C.reset}`);
}

interface Result {
  table: string;
  status: "PASS" | "LEAK" | "UNVERIFIED";
  detail?: string;
}
const results: Result[] = [];

function record(table: string, status: Result["status"], detail?: string) {
  results.push({ table, status, detail });
  if (status === "PASS") pass(`${table}${detail ? ": " + detail : ""}`);
  else if (status === "LEAK") fail(`${table}: ${detail}`);
  else unver(`${table}: ${detail}`);
}

// ============================================================================
// Guard "org lạ → refuse"
// ============================================================================
const BETACOM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const ORG_A_SLUG = "_verifygate2_org_a";
const ORG_B_SLUG = "_verifygate2_org_b";
const USER_A_OWNER_EMAIL = "verifygate2-a@test.local";
const USER_B_OWNER_EMAIL = "verifygate2-b@test.local";
const USER_A_VIEWER_EMAIL = "verifygate2-a-viewer@test.local";

async function guardCheckDbState(): Promise<void> {
  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, name, slug");
  if (error) {
    console.error(`${C.red}Guard: không đọc được organizations:${C.reset}`, error.message);
    process.exit(2);
  }
  const rows = orgs ?? [];
  const nonBetacom = rows.filter((o) => o.id !== BETACOM_ORG_ID);
  const nonBetacomNonSeed = nonBetacom.filter(
    (o) => o.slug !== ORG_A_SLUG && o.slug !== ORG_B_SLUG,
  );

  if (nonBetacomNonSeed.length > 0) {
    console.error(
      `${C.red}${C.bold}GUARD REFUSED: có org lạ ngoài Betacom + seed test:${C.reset}`,
    );
    nonBetacomNonSeed.forEach((o) =>
      console.error(`  - ${o.name} (${o.slug}, id=${o.id})`),
    );
    console.error(
      `\nProject này có org khách. KHÔNG chạy verify (nguy cơ đụng data).`,
    );
    console.error(`Nếu cần chạy: xóa các org này thủ công, rồi chạy lại.`);
    process.exit(2);
  }

  const existingSeeds = nonBetacom.filter(
    (o) => o.slug === ORG_A_SLUG || o.slug === ORG_B_SLUG,
  );
  if (existingSeeds.length > 0) {
    console.log(
      `${C.yellow}Phát hiện seed cũ còn lại (${existingSeeds.length} org) — cleanup trước.${C.reset}`,
    );
    for (const org of existingSeeds) {
      await cleanupSeedOrg(org.id, org.slug);
    }
  }

  // Cleanup users seed cũ (theo email prefix) — có thể còn từ fatal trước.
  const testEmails = [USER_A_OWNER_EMAIL, USER_B_OWNER_EMAIL, USER_A_VIEWER_EMAIL];
  const { data: usersList } = await admin.auth.admin.listUsers({ perPage: 200 });
  const staleUsers = (usersList?.users ?? []).filter((u) =>
    u.email && testEmails.includes(u.email),
  );
  if (staleUsers.length > 0) {
    console.log(
      `${C.yellow}Phát hiện user seed cũ còn lại (${staleUsers.length}) — cleanup trước.${C.reset}`,
    );
    for (const u of staleUsers) {
      await admin.auth.admin.deleteUser(u.id);
    }
  }
}

// ============================================================================
// Seed context — giữ id để verify sau
// ============================================================================
interface SeedCtx {
  orgAId: string;
  orgBId: string;
  userAOwnerId: string;
  userBOwnerId: string;
  userAViewerId: string;
  passwords: {
    userAOwner: string;
    userBOwner: string;
    userAViewer: string;
  };
  // Map bảng → { rowIdA, rowIdB } để verify bằng id
  rowIds: Record<string, { a: string; b: string }>;
  // Fk chain phụ cần giữ để seed bảng level cao
  fkChain: {
    warehouseA: string;
    warehouseB: string;
    warehouseAgentA: string;
    warehouseAgentB: string;
    staffProfileA: string;
    staffProfileB: string;
    cameraA: string;
    cameraB: string;
    orderA: string;
    orderB: string;
    packingStationA: string;
    packingStationB: string;
    rawEventA: string;
    rawEventB: string;
    stationDeviceA: string;
    stationDeviceB: string;
    cameraSessionA: string;
    cameraSessionB: string;
    workSessionA: string;
    workSessionB: string;
    packingEventA: string;
    packingEventB: string;
  };
}

function randPass(): string {
  return randomBytes(16).toString("hex");
}

// ============================================================================
// SEED — theo dependency order (Level 0 → 5)
// ============================================================================
async function seed(): Promise<SeedCtx> {
  section("SEED — tạo 2 org test + user + data 22 bảng");

  const ctx: SeedCtx = {
    orgAId: "",
    orgBId: "",
    userAOwnerId: "",
    userBOwnerId: "",
    userAViewerId: "",
    passwords: {
      userAOwner: randPass(),
      userBOwner: randPass(),
      userAViewer: randPass(),
    },
    rowIds: {},
    fkChain: {} as SeedCtx["fkChain"],
  };

  // Level 0 — organizations
  const { data: orgA, error: orgAErr } = await admin
    .from("organizations")
    .insert({ name: "_VerifyGate2 Org A", slug: ORG_A_SLUG })
    .select()
    .single();
  if (orgAErr || !orgA) throw new Error(`Seed orgA: ${orgAErr?.message}`);
  ctx.orgAId = orgA.id;

  const { data: orgB, error: orgBErr } = await admin
    .from("organizations")
    .insert({ name: "_VerifyGate2 Org B", slug: ORG_B_SLUG })
    .select()
    .single();
  if (orgBErr || !orgB) throw new Error(`Seed orgB: ${orgBErr?.message}`);
  ctx.orgBId = orgB.id;
  ctx.rowIds.organizations = { a: orgA.id, b: orgB.id };
  info(`Org A: ${ctx.orgAId}  Org B: ${ctx.orgBId}`);

  // Create auth users (owner A, owner B, viewer A)
  const createUser = async (email: string, pw: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`Create user ${email}: ${error?.message}`);
    return data.user.id;
  };
  ctx.userAOwnerId = await createUser(USER_A_OWNER_EMAIL, ctx.passwords.userAOwner);
  ctx.userBOwnerId = await createUser(USER_B_OWNER_EMAIL, ctx.passwords.userBOwner);
  ctx.userAViewerId = await createUser(USER_A_VIEWER_EMAIL, ctx.passwords.userAViewer);
  info(`Users created: A-owner ${ctx.userAOwnerId}, B-owner ${ctx.userBOwnerId}, A-viewer ${ctx.userAViewerId}`);

  // user_profiles (Level 1)
  const seedUserProfile = async (
    userId: string,
    orgId: string,
    role: string,
    fullName: string,
  ) => {
    const { error } = await admin.from("user_profiles").insert({
      id: userId,
      organization_id: orgId,
      role,
      full_name: fullName,
    });
    if (error) throw new Error(`user_profiles ${fullName}: ${error.message}`);
  };
  await seedUserProfile(ctx.userAOwnerId, ctx.orgAId, "owner", "_VG2 A Owner");
  await seedUserProfile(ctx.userBOwnerId, ctx.orgBId, "owner", "_VG2 B Owner");
  await seedUserProfile(ctx.userAViewerId, ctx.orgAId, "viewer", "_VG2 A Viewer");
  // user_profiles rowIds — dùng owner id cho A, B (2 record của 3 tổng, không sao)
  ctx.rowIds.user_profiles = { a: ctx.userAOwnerId, b: ctx.userBOwnerId };

  // Level 1 — warehouses
  const seedTable1 = async <T>(
    table: string,
    orgId: string,
    payload: Record<string, unknown>,
  ): Promise<T> => {
    const { data, error } = await admin
      .from(table)
      .insert({ organization_id: orgId, ...payload })
      .select()
      .single();
    if (error || !data) throw new Error(`${table}: ${error?.message}`);
    return data as T;
  };

  const whA = await seedTable1<{ id: string }>("warehouses", ctx.orgAId, {
    code: "_VG2_WH_A",
    name: "_VG2 Warehouse A",
  });
  const whB = await seedTable1<{ id: string }>("warehouses", ctx.orgBId, {
    code: "_VG2_WH_B",
    name: "_VG2 Warehouse B",
  });
  ctx.fkChain.warehouseA = whA.id;
  ctx.fkChain.warehouseB = whB.id;
  ctx.rowIds.warehouses = { a: whA.id, b: whB.id };

  // warehouse_agents
  const agentA = await seedTable1<{ id: string }>("warehouse_agents", ctx.orgAId, {
    code: "_vg2_agent_a",
    name: "_VG2 Agent A",
    secret: randomBytes(16).toString("hex"),
  });
  const agentB = await seedTable1<{ id: string }>("warehouse_agents", ctx.orgBId, {
    code: "_vg2_agent_b",
    name: "_VG2 Agent B",
    secret: randomBytes(16).toString("hex"),
  });
  ctx.fkChain.warehouseAgentA = agentA.id;
  ctx.fkChain.warehouseAgentB = agentB.id;
  ctx.rowIds.warehouse_agents = { a: agentA.id, b: agentB.id };

  // staff_profiles
  const staffA = await seedTable1<{ id: string }>("staff_profiles", ctx.orgAId, {
    staff_code: "_VG2_STAFF_A",
    full_name: "_VG2 Staff A",
  });
  const staffB = await seedTable1<{ id: string }>("staff_profiles", ctx.orgBId, {
    staff_code: "_VG2_STAFF_B",
    full_name: "_VG2 Staff B",
  });
  ctx.fkChain.staffProfileA = staffA.id;
  ctx.fkChain.staffProfileB = staffB.id;
  ctx.rowIds.staff_profiles = { a: staffA.id, b: staffB.id };

  // cameras
  const camA = await seedTable1<{ id: string }>("cameras", ctx.orgAId, {
    name: "_VG2 Camera A",
    camera_code: "_VG2_CAM_A",
    ip: "10.0.0.1",
  });
  const camB = await seedTable1<{ id: string }>("cameras", ctx.orgBId, {
    name: "_VG2 Camera B",
    camera_code: "_VG2_CAM_B",
    ip: "10.0.0.2",
  });
  ctx.fkChain.cameraA = camA.id;
  ctx.fkChain.cameraB = camB.id;
  ctx.rowIds.cameras = { a: camA.id, b: camB.id };

  // orders
  const orderA = await seedTable1<{ id: string }>("orders", ctx.orgAId, {
    waybill_code: "_VG2_ORD_A",
  });
  const orderB = await seedTable1<{ id: string }>("orders", ctx.orgBId, {
    waybill_code: "_VG2_ORD_B",
  });
  ctx.fkChain.orderA = orderA.id;
  ctx.fkChain.orderB = orderB.id;
  ctx.rowIds.orders = { a: orderA.id, b: orderB.id };

  // audit_logs
  const auditA = await seedTable1<{ id: string }>("audit_logs", ctx.orgAId, {
    action: "verify_gate2_seed",
  });
  const auditB = await seedTable1<{ id: string }>("audit_logs", ctx.orgBId, {
    action: "verify_gate2_seed",
  });
  ctx.rowIds.audit_logs = { a: auditA.id, b: auditB.id };

  // Level 2 — packing_stations, staff_qr_credentials, warehouse_scan_raw_events, station_devices, camera_recording_sessions
  const psA = await seedTable1<{ id: string }>("packing_stations", ctx.orgAId, {
    warehouse_id: ctx.fkChain.warehouseA,
    code: "_VG2_PS_A",
    name: "_VG2 Station A",
  });
  const psB = await seedTable1<{ id: string }>("packing_stations", ctx.orgBId, {
    warehouse_id: ctx.fkChain.warehouseB,
    code: "_VG2_PS_B",
    name: "_VG2 Station B",
  });
  ctx.fkChain.packingStationA = psA.id;
  ctx.fkChain.packingStationB = psB.id;
  ctx.rowIds.packing_stations = { a: psA.id, b: psB.id };

  const qrA = await seedTable1<{ id: string }>("staff_qr_credentials", ctx.orgAId, {
    staff_id: ctx.fkChain.staffProfileA,
    token_hash: randomBytes(32).toString("hex"),
    token_prefix: "vg2a",
  });
  const qrB = await seedTable1<{ id: string }>("staff_qr_credentials", ctx.orgBId, {
    staff_id: ctx.fkChain.staffProfileB,
    token_hash: randomBytes(32).toString("hex"),
    token_prefix: "vg2b",
  });
  ctx.rowIds.staff_qr_credentials = { a: qrA.id, b: qrB.id };

  const rawA = await seedTable1<{ id: string }>("warehouse_scan_raw_events", ctx.orgAId, {
    scanner_device_code: "_VG2_DEV_A",
    raw_value: "_VG2_RAW_A",
    scan_type: "waybill",
    scanned_at: new Date().toISOString(),
    agent_event_id: randomUUID(),
  });
  const rawB = await seedTable1<{ id: string }>("warehouse_scan_raw_events", ctx.orgBId, {
    scanner_device_code: "_VG2_DEV_B",
    raw_value: "_VG2_RAW_B",
    scan_type: "waybill",
    scanned_at: new Date().toISOString(),
    agent_event_id: randomUUID(),
  });
  ctx.fkChain.rawEventA = rawA.id;
  ctx.fkChain.rawEventB = rawB.id;
  ctx.rowIds.warehouse_scan_raw_events = { a: rawA.id, b: rawB.id };

  const devA = await seedTable1<{ id: string }>("station_devices", ctx.orgAId, {
    device_code: "_VG2_SD_A",
    device_type: "scanner",
    name: "_VG2 Device A",
  });
  const devB = await seedTable1<{ id: string }>("station_devices", ctx.orgBId, {
    device_code: "_VG2_SD_B",
    device_type: "scanner",
    name: "_VG2 Device B",
  });
  ctx.fkChain.stationDeviceA = devA.id;
  ctx.fkChain.stationDeviceB = devB.id;
  ctx.rowIds.station_devices = { a: devA.id, b: devB.id };

  const crsA = await seedTable1<{ id: string }>("camera_recording_sessions", ctx.orgAId, {
    camera_id: ctx.fkChain.cameraA,
    output_dir: "/tmp/_vg2_a",
  });
  const crsB = await seedTable1<{ id: string }>("camera_recording_sessions", ctx.orgBId, {
    camera_id: ctx.fkChain.cameraB,
    output_dir: "/tmp/_vg2_b",
  });
  ctx.fkChain.cameraSessionA = crsA.id;
  ctx.fkChain.cameraSessionB = crsB.id;
  ctx.rowIds.camera_recording_sessions = { a: crsA.id, b: crsB.id };

  // Level 3 — staff_work_sessions, station_device_assignments, camera_recording_files, agent_commands, staff_warehouse_assignments
  const wsA = await seedTable1<{ id: string }>("staff_work_sessions", ctx.orgAId, {
    warehouse_id: ctx.fkChain.warehouseA,
    station_id: ctx.fkChain.packingStationA,
    staff_id: ctx.fkChain.staffProfileA,
    started_at: new Date().toISOString(),
    status: "active",
    start_raw_event_id: ctx.fkChain.rawEventA,
  });
  const wsB = await seedTable1<{ id: string }>("staff_work_sessions", ctx.orgBId, {
    warehouse_id: ctx.fkChain.warehouseB,
    station_id: ctx.fkChain.packingStationB,
    staff_id: ctx.fkChain.staffProfileB,
    started_at: new Date().toISOString(),
    status: "active",
    start_raw_event_id: ctx.fkChain.rawEventB,
  });
  ctx.fkChain.workSessionA = wsA.id;
  ctx.fkChain.workSessionB = wsB.id;
  ctx.rowIds.staff_work_sessions = { a: wsA.id, b: wsB.id };

  const sdaA = await seedTable1<{ id: string }>("station_device_assignments", ctx.orgAId, {
    device_id: ctx.fkChain.stationDeviceA,
    station_id: ctx.fkChain.packingStationA,
  });
  const sdaB = await seedTable1<{ id: string }>("station_device_assignments", ctx.orgBId, {
    device_id: ctx.fkChain.stationDeviceB,
    station_id: ctx.fkChain.packingStationB,
  });
  ctx.rowIds.station_device_assignments = { a: sdaA.id, b: sdaB.id };

  const crfA = await seedTable1<{ id: string }>("camera_recording_files", ctx.orgAId, {
    camera_id: ctx.fkChain.cameraA,
    recording_session_id: ctx.fkChain.cameraSessionA,
    file_path: "/tmp/_vg2_a/f.mp4",
    file_name: "_vg2_a.mp4",
    started_at: new Date().toISOString(),
  });
  const crfB = await seedTable1<{ id: string }>("camera_recording_files", ctx.orgBId, {
    camera_id: ctx.fkChain.cameraB,
    recording_session_id: ctx.fkChain.cameraSessionB,
    file_path: "/tmp/_vg2_b/f.mp4",
    file_name: "_vg2_b.mp4",
    started_at: new Date().toISOString(),
  });
  ctx.rowIds.camera_recording_files = { a: crfA.id, b: crfB.id };

  const acA = await seedTable1<{ id: string }>("agent_commands", ctx.orgAId, {
    agent_id: ctx.fkChain.warehouseAgentA,
    type: "ping",
  });
  const acB = await seedTable1<{ id: string }>("agent_commands", ctx.orgBId, {
    agent_id: ctx.fkChain.warehouseAgentB,
    type: "ping",
  });
  ctx.rowIds.agent_commands = { a: acA.id, b: acB.id };

  const swaA = await seedTable1<{ id: string }>("staff_warehouse_assignments", ctx.orgAId, {
    staff_id: ctx.fkChain.staffProfileA,
    warehouse_id: ctx.fkChain.warehouseA,
  });
  const swaB = await seedTable1<{ id: string }>("staff_warehouse_assignments", ctx.orgBId, {
    staff_id: ctx.fkChain.staffProfileB,
    warehouse_id: ctx.fkChain.warehouseB,
  });
  ctx.rowIds.staff_warehouse_assignments = { a: swaA.id, b: swaB.id };

  // Level 4 — packing_events, staff_qr_scan_results, staff_work_session_events
  const peA = await seedTable1<{ id: string }>("packing_events", ctx.orgAId, {
    raw_event_id: ctx.fkChain.rawEventA,
    waybill_code: "_VG2_PE_A",
    scanner_device_code: "_VG2_DEV_A",
    scanned_at: new Date().toISOString(),
    status: "valid",
  });
  const peB = await seedTable1<{ id: string }>("packing_events", ctx.orgBId, {
    raw_event_id: ctx.fkChain.rawEventB,
    waybill_code: "_VG2_PE_B",
    scanner_device_code: "_VG2_DEV_B",
    scanned_at: new Date().toISOString(),
    status: "valid",
  });
  ctx.fkChain.packingEventA = peA.id;
  ctx.fkChain.packingEventB = peB.id;
  ctx.rowIds.packing_events = { a: peA.id, b: peB.id };

  // staff_qr_scan_results — unique raw_event_id, cần raw event RIÊNG cho ca này
  const rawA2 = await seedTable1<{ id: string }>("warehouse_scan_raw_events", ctx.orgAId, {
    scanner_device_code: "_VG2_DEV_A",
    raw_value: "_VG2_RAW_A_QR",
    scan_type: "staff_qr",
    scanned_at: new Date().toISOString(),
    agent_event_id: randomUUID(),
  });
  const rawB2 = await seedTable1<{ id: string }>("warehouse_scan_raw_events", ctx.orgBId, {
    scanner_device_code: "_VG2_DEV_B",
    raw_value: "_VG2_RAW_B_QR",
    scan_type: "staff_qr",
    scanned_at: new Date().toISOString(),
    agent_event_id: randomUUID(),
  });
  const qrsA = await seedTable1<{ id: string }>("staff_qr_scan_results", ctx.orgAId, {
    raw_event_id: rawA2.id,
    action: "checked_in",
  });
  const qrsB = await seedTable1<{ id: string }>("staff_qr_scan_results", ctx.orgBId, {
    raw_event_id: rawB2.id,
    action: "checked_in",
  });
  ctx.rowIds.staff_qr_scan_results = { a: qrsA.id, b: qrsB.id };

  const wseA = await seedTable1<{ id: string }>("staff_work_session_events", ctx.orgAId, {
    work_session_id: ctx.fkChain.workSessionA,
    event_type: "started",
    occurred_at: new Date().toISOString(),
  });
  const wseB = await seedTable1<{ id: string }>("staff_work_session_events", ctx.orgBId, {
    work_session_id: ctx.fkChain.workSessionB,
    event_type: "started",
    occurred_at: new Date().toISOString(),
  });
  ctx.rowIds.staff_work_session_events = { a: wseA.id, b: wseB.id };

  // Level 5 — order_proof_clips
  const opcA = await seedTable1<{ id: string }>("order_proof_clips", ctx.orgAId, {
    packing_event_id: ctx.fkChain.packingEventA,
    waybill_code: "_VG2_OPC_A",
    camera_id: ctx.fkChain.cameraA,
  });
  const opcB = await seedTable1<{ id: string }>("order_proof_clips", ctx.orgBId, {
    packing_event_id: ctx.fkChain.packingEventB,
    waybill_code: "_VG2_OPC_B",
    camera_id: ctx.fkChain.cameraB,
  });
  ctx.rowIds.order_proof_clips = { a: opcA.id, b: opcB.id };

  info(`Seed xong: 22 bảng org-scoped, 2 org × 1 row/bảng.`);
  return ctx;
}

// ============================================================================
// Login helpers — dùng anon key + signInWithPassword để có session tenant
// ============================================================================
async function loginAs(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(SUPA_URL, ANON);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login ${email}: ${error.message}`);
  return client;
}

// ============================================================================
// VERIFY BƯỚC 3 — 22 bảng cross-tenant hai chiều (verify bằng ID, không count)
// ============================================================================
const TABLES_22 = [
  "warehouses",
  "warehouse_agents",
  "staff_profiles",
  "cameras",
  "orders",
  "user_profiles",
  "audit_logs",
  "packing_stations",
  "staff_qr_credentials",
  "warehouse_scan_raw_events",
  "station_devices",
  "camera_recording_sessions",
  "staff_work_sessions",
  "station_device_assignments",
  "camera_recording_files",
  "agent_commands",
  "staff_warehouse_assignments",
  "packing_events",
  "staff_qr_scan_results",
  "staff_work_session_events",
  "order_proof_clips",
  "organizations",
];

async function verifyCrossTenantById(
  ctx: SeedCtx,
  clientAOwner: SupabaseClient,
  clientBOwner: SupabaseClient,
): Promise<void> {
  section("BƯỚC 3 — Cross-tenant 22 bảng (verify bằng ID, không count)");
  for (const table of TABLES_22) {
    const rowIds = ctx.rowIds[table];
    if (!rowIds || !rowIds.a || !rowIds.b) {
      record(table, "UNVERIFIED", "không có rowId seed (bảng chưa seed hoặc seed fail)");
      continue;
    }

    // Nửa-dương A: query bằng id-A → phải thấy 1 row (id đúng org A)
    // Nửa-âm A: query bằng id-B → phải thấy 0 row (RLS chặn cross-tenant)
    const posA = await clientAOwner.from(table).select("id").eq("id", rowIds.a).maybeSingle();
    const negA = await clientAOwner.from(table).select("id").eq("id", rowIds.b).maybeSingle();

    if (posA.error && posA.error.code !== "PGRST116") {
      record(table, "UNVERIFIED", `nửa-dương A query lỗi: ${posA.error.message}`);
      continue;
    }
    if (negA.error && negA.error.code !== "PGRST116") {
      record(table, "UNVERIFIED", `nửa-âm A query lỗi: ${negA.error.message}`);
      continue;
    }

    const posAOk = posA.data?.id === rowIds.a;
    const negAOk = !negA.data; // không tìm thấy row B = kín cross-tenant

    // Đối xứng B
    const posB = await clientBOwner.from(table).select("id").eq("id", rowIds.b).maybeSingle();
    const negB = await clientBOwner.from(table).select("id").eq("id", rowIds.a).maybeSingle();

    if (posB.error && posB.error.code !== "PGRST116") {
      record(table, "UNVERIFIED", `nửa-dương B query lỗi: ${posB.error.message}`);
      continue;
    }
    if (negB.error && negB.error.code !== "PGRST116") {
      record(table, "UNVERIFIED", `nửa-âm B query lỗi: ${negB.error.message}`);
      continue;
    }

    const posBOk = posB.data?.id === rowIds.b;
    const negBOk = !negB.data;

    if (!posAOk) {
      record(
        table,
        "LEAK",
        `nửa-dương A SAI: user A query id=${rowIds.a} (row của mình) không thấy — RLS chặn nhầm chính chủ`,
      );
      continue;
    }
    if (!posBOk) {
      record(
        table,
        "LEAK",
        `nửa-dương B SAI: user B query id=${rowIds.b} (row của mình) không thấy — RLS chặn nhầm chính chủ`,
      );
      continue;
    }
    if (!negAOk) {
      record(
        table,
        "LEAK",
        `nửa-âm A SAI: user A THẤY row org B id=${rowIds.b} — LEAK cross-tenant A→B`,
      );
      continue;
    }
    if (!negBOk) {
      record(
        table,
        "LEAK",
        `nửa-âm B SAI: user B THẤY row org A id=${rowIds.a} — LEAK cross-tenant B→A`,
      );
      continue;
    }

    record(
      table,
      "PASS",
      `A thấy id-A + không thấy id-B; B thấy id-B + không thấy id-A`,
    );
  }
}

// ============================================================================
// BƯỚC 4 — Role-check nhánh viewer.
//
// Bảng NHẠY có role-check SELECT (viewer không đọc): staff_qr_credentials,
// audit_logs. Kỳ vọng viewer org A → 0 row.
//
// Bảng METADATA có role-check UPDATE (viewer đọc OK, không sửa):
// organizations. Verify pg_policies 2026-07-03: SELECT qual =
// `(is_platform_admin() OR id = current_org_id())` — KHÔNG role-check
// SELECT; role-check chỉ ở UPDATE. Nên viewer đọc org mình = đúng thiết kế
// (UI cần hiển thị org name cho mọi role). Test viewer-đọc organizations là
// SAI kỳ vọng — gộp với 2 bảng nhạy là bẫy áp-mẫu-hàng-loạt.
// Test riêng: viewer có UPDATE được organizations không (kỳ vọng: KHÔNG).
// ============================================================================
const ROLE_CHECK_SELECT_TABLES = ["staff_qr_credentials", "audit_logs"];

async function verifyRoleCheck(
  ctx: SeedCtx,
  clientAViewer: SupabaseClient,
): Promise<void> {
  section("BƯỚC 4 — Role-check viewer (SELECT chặn 2 bảng nhạy + UPDATE chặn organizations)");

  // Phần 1: 2 bảng nhạy — role-check SELECT chặn viewer đọc
  for (const table of ROLE_CHECK_SELECT_TABLES) {
    const rowIds = ctx.rowIds[table];
    if (!rowIds) {
      record(`${table}[role-viewer-SELECT]`, "UNVERIFIED", "không có rowId seed");
      continue;
    }

    const res = await clientAViewer
      .from(table)
      .select("id")
      .eq("id", rowIds.a)
      .maybeSingle();

    if (res.error && res.error.code !== "PGRST116") {
      record(`${table}[role-viewer-SELECT]`, "UNVERIFIED", `query lỗi: ${res.error.message}`);
      continue;
    }

    if (!res.data) {
      record(
        `${table}[role-viewer-SELECT]`,
        "PASS",
        `viewer org A không thấy row org A (role-check SELECT chặn) — kín`,
      );
    } else {
      record(
        `${table}[role-viewer-SELECT]`,
        "LEAK",
        `viewer org A THẤY row org A id=${rowIds.a} — role-check SELECT HỎNG (viewer thấy cái chỉ owner/admin được, dù cùng org)`,
      );
    }
  }

  // Phần 2: organizations — role-check UPDATE (viewer đọc OK, không sửa)
  const orgRowIds = ctx.rowIds.organizations;
  if (!orgRowIds) {
    record("organizations[role-viewer-UPDATE]", "UNVERIFIED", "không có orgId seed");
  } else {
    // Verify viewer đọc org A OK (kỳ vọng thiết kế: có SELECT quyền)
    const readRes = await clientAViewer
      .from("organizations")
      .select("id")
      .eq("id", orgRowIds.a)
      .maybeSingle();
    if (readRes.error && readRes.error.code !== "PGRST116") {
      record(
        "organizations[role-viewer-SELECT]",
        "UNVERIFIED",
        `read lỗi: ${readRes.error.message}`,
      );
    } else if (readRes.data) {
      record(
        "organizations[role-viewer-SELECT]",
        "PASS",
        `viewer org A đọc được org mình (đúng thiết kế metadata)`,
      );
    } else {
      // Viewer không đọc được org mình = policy SELECT chặn nhầm, UI vỡ
      record(
        "organizations[role-viewer-SELECT]",
        "LEAK",
        `viewer org A KHÔNG đọc được org mình id=${orgRowIds.a} — policy SELECT chặn nhầm, UI sẽ vỡ hiển thị org name`,
      );
    }

    // Verify viewer KHÔNG UPDATE được org A (kỳ vọng: chặn — role-check UPDATE)
    const updateRes = await clientAViewer
      .from("organizations")
      .update({ name: "_VG2_VIEWER_HACK_ATTEMPT" })
      .eq("id", orgRowIds.a)
      .select();
    // RLS chặn UPDATE thường trả 0 row updated (không error), hoặc lỗi permission
    const updateCount = updateRes.data?.length ?? 0;
    if (updateCount === 0) {
      record(
        "organizations[role-viewer-UPDATE]",
        "PASS",
        `viewer org A KHÔNG UPDATE được organizations (role-check UPDATE chặn)`,
      );
    } else {
      record(
        "organizations[role-viewer-UPDATE]",
        "LEAK",
        `viewer org A UPDATE được organizations (${updateCount} rows) — role-check UPDATE HỎNG`,
      );
    }
  }
}

// ============================================================================
// BƯỚC 5 — Platform-token nhánh nửa-âm
// (Platform token org A → thấy A + KHÔNG thấy B, không phải "thấy all")
// ============================================================================
async function verifyPlatformToken(ctx: SeedCtx): Promise<void> {
  section("BƯỚC 5 — Platform-token org A → thấy A, KHÔNG thấy B (không thấy all)");

  // Cần platform-admin session (betacomagency@gmail.com). Guard đọc token via
  // header, mà supabase-js client không dễ set header custom cho tất cả query.
  //
  // Cách kiểm: dùng REST endpoint Betabox thay vì supabase-js — POST tới
  // /api/warehouses với session platform-admin + header x-internal-org-ctx signed.
  //
  // Nhưng verify này cần session Betabox thật (MFA), phức tạp cho script tự động.
  // Skip ở đây với severity UNVERIFIED + note test tay hoặc script riêng
  // (test-platform-impersonate.ts refactor cookie-carrier ở ca 5).
  //
  // Alternative rẻ: verify tại DB layer — kiểm RLS policy có `is_platform_admin()`
  // branch giới hạn theo org-token không. Đọc policy definition.

  // Verify tối thiểu: sign token org A + query REST có session platform-admin
  // = phức tạp. Đề nghị: skip verify programmatic ở đây, ghi UNVERIFIED cho
  // 3 bảng đại diện + hướng dẫn test tay.

  for (const table of ["warehouses", "orders", "cameras"]) {
    record(
      `${table}[platform-token]`,
      "UNVERIFIED",
      `verify platform-token cần session MFA — làm ở ca 5 script refactor cookie-carrier`,
    );
  }
  info(`Nhánh platform-token skip — verify ở ca 5 (test-platform-impersonate.ts refactor).`);
}

// ============================================================================
// BƯỚC 6 — 5 bảng non-org-scoped
// ============================================================================
async function verifyNonOrgScoped(
  ctx: SeedCtx,
  clientAOwner: SupabaseClient,
): Promise<void> {
  section("BƯỚC 6 — 5 bảng non-org-scoped");

  // platform_admins: tenant KHÔNG thấy
  const paRes = await clientAOwner.from("platform_admins").select("id");
  if (paRes.error && paRes.error.code !== "PGRST116") {
    record("platform_admins", "UNVERIFIED", `query lỗi: ${paRes.error.message}`);
  } else if (!paRes.data || paRes.data.length === 0) {
    record("platform_admins", "PASS", "tenant không thấy platform_admins (0 rows)");
  } else {
    record(
      "platform_admins",
      "LEAK",
      `tenant THẤY ${paRes.data.length} platform_admins — LEAK`,
    );
  }

  // signup_attempts: email/IP không được lộ cross-tenant
  const saRes = await clientAOwner.from("signup_attempts").select("id");
  if (saRes.error && saRes.error.code !== "PGRST116") {
    record("signup_attempts", "UNVERIFIED", `query lỗi: ${saRes.error.message}`);
  } else if (!saRes.data || saRes.data.length === 0) {
    record("signup_attempts", "PASS", "tenant không thấy signup_attempts");
  } else {
    record(
      "signup_attempts",
      "LEAK",
      `tenant THẤY ${saRes.data.length} signup_attempts — email/IP lộ`,
    );
  }

  // 3 matrix: role_permission_matrix + platform_permission_matrix + platform_audit_log
  // role_permission_matrix: tenant đọc được (matrix chung), không sửa
  const rpmRes = await clientAOwner.from("role_permission_matrix").select("role").limit(1);
  if (rpmRes.error && rpmRes.error.code !== "PGRST116") {
    record("role_permission_matrix", "UNVERIFIED", `query lỗi: ${rpmRes.error.message}`);
  } else {
    record(
      "role_permission_matrix",
      "PASS",
      `tenant đọc được matrix chung (${rpmRes.data?.length ?? 0} rows visible)`,
    );
  }

  const ppmRes = await clientAOwner.from("platform_permission_matrix").select("*").limit(1);
  if (ppmRes.error && ppmRes.error.code !== "PGRST116") {
    record("platform_permission_matrix", "UNVERIFIED", `query lỗi: ${ppmRes.error.message}`);
  } else if (!ppmRes.data || ppmRes.data.length === 0) {
    record(
      "platform_permission_matrix",
      "PASS",
      "tenant không thấy platform_permission_matrix (0 rows)",
    );
  } else {
    record(
      "platform_permission_matrix",
      "UNVERIFIED",
      `tenant thấy ${ppmRes.data.length} rows — review policy (có thể ý đồ)`,
    );
  }

  const palRes = await clientAOwner.from("platform_audit_log").select("id").limit(1);
  if (palRes.error && palRes.error.code !== "PGRST116") {
    record("platform_audit_log", "UNVERIFIED", `query lỗi: ${palRes.error.message}`);
  } else if (!palRes.data || palRes.data.length === 0) {
    record("platform_audit_log", "PASS", "tenant không thấy platform_audit_log");
  } else {
    record(
      "platform_audit_log",
      "LEAK",
      `tenant THẤY ${palRes.data.length} platform_audit_log`,
    );
  }
}

// ============================================================================
// CLEANUP — theo FK reverse order
// ============================================================================
async function cleanupSeedOrg(orgId: string, slug: string): Promise<void> {
  console.log(`  Cleanup org ${slug} (${orgId})...`);
  // Reverse order: level 5 → 4 → 3 → 2 → 1 → 0
  const tables = [
    "order_proof_clips",
    "staff_work_session_events",
    "staff_qr_scan_results",
    "packing_events",
    "staff_warehouse_assignments",
    "agent_commands",
    "camera_recording_files",
    "station_device_assignments",
    "staff_work_sessions",
    "camera_recording_sessions",
    "station_devices",
    "warehouse_scan_raw_events",
    "staff_qr_credentials",
    "packing_stations",
    "audit_logs",
    "orders",
    "cameras",
    "staff_profiles",
    "warehouse_agents",
    "warehouses",
    "user_profiles",
  ];
  for (const t of tables) {
    await admin.from(t).delete().eq("organization_id", orgId);
  }
  await admin.from("organizations").delete().eq("id", orgId);
}

async function cleanupUsers(userIds: string[]): Promise<void> {
  for (const uid of userIds) {
    if (uid) await admin.auth.admin.deleteUser(uid);
  }
}

async function cleanup(ctx: SeedCtx): Promise<void> {
  section("CLEANUP — xóa seed theo FK reverse order");
  if (ctx.orgAId) await cleanupSeedOrg(ctx.orgAId, ORG_A_SLUG);
  if (ctx.orgBId) await cleanupSeedOrg(ctx.orgBId, ORG_B_SLUG);
  await cleanupUsers([ctx.userAOwnerId, ctx.userBOwnerId, ctx.userAViewerId]);

  // Verify cleanup sạch
  const { data: leftover } = await admin
    .from("organizations")
    .select("id, slug")
    .in("slug", [ORG_A_SLUG, ORG_B_SLUG]);
  if (leftover && leftover.length > 0) {
    console.error(
      `${C.red}Cleanup không sạch — còn ${leftover.length} org:${C.reset}`,
      leftover,
    );
  } else {
    info("Cleanup sạch, DB về trạng thái ban đầu.");
  }
}

// ============================================================================
// SUMMARY
// ============================================================================
function summary(): number {
  section("KẾT QUẢ GATE 2");
  const pass = results.filter((r) => r.status === "PASS").length;
  const leak = results.filter((r) => r.status === "LEAK").length;
  const unver = results.filter((r) => r.status === "UNVERIFIED").length;

  console.log(`  ${C.green}PASS:${C.reset} ${pass}`);
  console.log(`  ${C.red}LEAK:${C.reset} ${leak}`);
  console.log(`  ${C.yellow}UNVERIFIED:${C.reset} ${unver}`);

  if (leak > 0) {
    console.log(`\n${C.red}${C.bold}GATE 2 ĐỎ — có LEAK cross-tenant. KHÔNG mở V6.${C.reset}`);
    return 1;
  }
  if (unver > 0) {
    console.log(
      `\n${C.yellow}${C.bold}GATE 2 CHƯA XONG — có UNVERIFIED. Sửa seed hoặc review policy trước khi tuyên xanh.${C.reset}`,
    );
    return 2;
  }
  console.log(`\n${C.green}${C.bold}GATE 2 XANH — cross-tenant kín. Điều kiện mở V6 đạt.${C.reset}`);
  return 0;
}

// ============================================================================
// MAIN
// ============================================================================
async function main(): Promise<void> {
  console.log(`${C.bold}${C.cyan}=== Gate 2 Verify RLS Cross-Tenant ===${C.reset}`);
  console.log(`Project: ${SUPA_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  await guardCheckDbState();

  let ctx: SeedCtx | null = null;
  let exitCode = 0;
  try {
    ctx = await seed();

    const clientAOwner = await loginAs(USER_A_OWNER_EMAIL, ctx.passwords.userAOwner);
    const clientBOwner = await loginAs(USER_B_OWNER_EMAIL, ctx.passwords.userBOwner);
    const clientAViewer = await loginAs(USER_A_VIEWER_EMAIL, ctx.passwords.userAViewer);

    await verifyCrossTenantById(ctx, clientAOwner, clientBOwner);
    await verifyRoleCheck(ctx, clientAViewer);
    await verifyPlatformToken(ctx);
    await verifyNonOrgScoped(ctx, clientAOwner);

    exitCode = summary();
  } catch (e) {
    console.error(`\n${C.red}${C.bold}FATAL — seed hoặc verify throw:${C.reset}`, e);
    exitCode = 3;
  } finally {
    if (ctx) {
      try {
        await cleanup(ctx);
      } catch (e) {
        console.error(`${C.red}Cleanup lỗi:${C.reset}`, e);
      }
    }
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("Unhandled:", e);
  process.exit(4);
});
