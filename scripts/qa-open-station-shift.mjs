import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";
const STATION_ID = "7f5c2e64-a82e-4f7b-957f-8abfc7cf803c";
const SCANNER_CODE = "qrcam_dahua_3";
const SCAN_PATH = "/api/warehouse/scans";
const expectedAction = process.argv[2] ?? "checked_in";
if (!["checked_in", "checked_out"].includes(expectedAction)) {
  throw new Error("Expected action must be checked_in or checked_out");
}

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function signedHeaders(agentCode, agentSecret, body) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = [
    "v2",
    agentCode,
    "POST",
    SCAN_PATH,
    bodyHash,
    timestamp,
    nonce,
  ].join("\n");
  return {
    "content-type": "application/json",
    "x-agent-code": agentCode,
    "x-agent-timestamp": timestamp,
    "x-agent-signature": createHmac("sha256", agentSecret)
      .update(canonical)
      .digest("hex"),
    "x-agent-sig-version": "v2",
    "x-agent-nonce": nonce,
  };
}

const [appEnvText, agentEnvText] = await Promise.all([
  readFile(".env.local", "utf8"),
  readFile("BetacomAgent/.env", "utf8"),
]);
const appEnv = parseEnv(appEnvText);
const agentEnv = parseEnv(agentEnvText);
const admin = createClient(
  appEnv.NEXT_PUBLIC_SUPABASE_URL,
  appEnv.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { data: credentials, error: credentialError } = await admin
  .from("staff_qr_credentials")
  .select("payload,staff_id,staff_profiles!inner(staff_code,full_name,status)")
  .eq("organization_id", ORGANIZATION_ID)
  .eq("status", "active")
  .not("payload", "is", null)
  .limit(10);
if (credentialError) throw credentialError;
const credential = (credentials ?? []).find(
  (row) => row.staff_profiles?.status === "active",
);
if (!credential?.payload) throw new Error("No active staff QR is available");

const body = JSON.stringify({
  agent_event_id: randomUUID(),
  scanner_device_code: SCANNER_CODE,
  port: "camera:dahua_3",
  raw_value: credential.payload,
  scanned_at: new Date().toISOString(),
  source: "camera_qr",
  device_identity_snapshot: { qa_run: "QA-2CAM-QR-SEGMENT-COMPOSE" },
});
const response = await fetch(`http://localhost:3000${SCAN_PATH}`, {
  method: "POST",
  headers: signedHeaders(agentEnv.AGENT_CODE, agentEnv.AGENT_SECRET, body),
  body,
});
const scanResult = await response.json();
if (!response.ok) {
  throw new Error(`Open-shift scan failed (${response.status}): ${JSON.stringify(scanResult)}`);
}
if (scanResult.session_action?.action !== expectedAction) {
  throw new Error(`Expected ${expectedAction}, got ${JSON.stringify(scanResult.session_action)}`);
}
if (scanResult.session_action.station_id !== STATION_ID) {
  throw new Error(`Staff QR resolved to unexpected station ${scanResult.session_action.station_id}`);
}

const { data: agent, error: agentError } = await admin
  .from("warehouse_agents")
  .select("id")
  .eq("organization_id", ORGANIZATION_ID)
  .eq("station_id", STATION_ID)
  .eq("status", "active")
  .single();
if (agentError || !agent) throw agentError ?? new Error("Station agent not found");

const { data: assignments, error: assignmentError } = await admin
  .from("station_device_assignments")
  .select("station_devices!inner(device_type,config_json)")
  .eq("organization_id", ORGANIZATION_ID)
  .eq("station_id", STATION_ID)
  .is("unassigned_at", null);
if (assignmentError) throw assignmentError;
const cameraIds = [...new Set(
  (assignments ?? [])
    .filter((row) => row.station_devices?.device_type === "camera")
    .map((row) => row.station_devices?.config_json?.camera_id)
    .filter(Boolean),
)];
if (cameraIds.length !== 2) {
  throw new Error(`Expected exactly two assigned cameras, found ${cameraIds.length}`);
}

const { data: cameras, error: cameraError } = await admin
  .from("cameras")
  .select("id,camera_code,agent_id,status")
  .in("id", cameraIds)
  .eq("organization_id", ORGANIZATION_ID);
if (cameraError) throw cameraError;
if ((cameras ?? []).some((camera) => camera.agent_id !== agent.id || camera.status !== "active")) {
  throw new Error("Assigned cameras are not active on the station agent");
}

const recordingResults = [];
if (expectedAction === "checked_in") {
  for (const camera of cameras ?? []) {
    const { data, error } = await admin.rpc("enqueue_start_recording", {
      p_organization_id: ORGANIZATION_ID,
      p_camera_id: camera.id,
      p_agent_id: agent.id,
      p_created_by: null,
      p_transport: "tcp",
      p_segment_seconds: 60,
      p_output_dir: `_agent_managed/${camera.camera_code}`,
    });
    if (error) throw error;
    recordingResults.push({ camera_code: camera.camera_code, verdict: data?.[0]?.verdict });
  }
}

console.log(JSON.stringify({
  staff_code: credential.staff_profiles.staff_code,
  session_action: scanResult.session_action.action,
  session_id: scanResult.session_action.session_id,
  station_id: scanResult.session_action.station_id,
  recording_results: recordingResults,
}, null, 2));
