/**
 * Chuyển qua lại giữa luồng đóng hàng và luồng hoàn hàng, nhiều vòng liên
 * tiếp, kiểm từng vòng một.
 *
 * Vì sao có script này: chủ dự án báo 24/09/2026 "chuyển từ đóng hàng sang
 * hoàn hàng thì chưa sao nhưng chuyển ngược lại thì không được", và yêu cầu
 * test tới khi chuyển qua lại liên tục mà không có vấn đề gì.
 *
 * Mỗi vòng kiểm bốn điều:
 *   1. BẬT  → chế độ bàn = return, phiên = active, có tên người giữ.
 *   2. Cloud khai báo phiên đó cho máy kho qua heartbeat (trạng thái, không
 *      phải lệnh — đây là chỗ hỏng cũ: bốn đường đóng kỳ không báo agent).
 *   3. TẮT  → chế độ bàn = outbound, hết người giữ, phiên không còn active.
 *   4. Heartbeat không còn liệt kê phiên đó.
 *
 * Kèm hai tình huống khó:
 *   - Người giữ treo (tab chết): tạo tên giữ rác rồi tắt — phải ép được.
 *   - Hai tab cùng bật một bàn: tab này tắt thì bàn vẫn nhận hoàn.
 *
 * CHỈ chạy trên kho test (org 00000000-...-0001). Mọi tài khoản tạm đều
 * được xoá ở cuối, kể cả khi lỗi.
 *
 * Dùng: node scripts/qa-mode-switch-loop.mjs [số_vòng]
 */
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const ORG = "00000000-0000-0000-0000-000000000001";
const BASE = process.env.QA_BASE_URL ?? "https://localhost:3000";
const ROUNDS = Number(process.argv[2] ?? 12);

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim()];
    }),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

let failures = 0;
function check(ok, label) {
  if (!ok) failures += 1;
  console.log(`${ok ? "DAT " : "SAI "}${label}`);
}

async function login(email, password) {
  const jar = new Map();
  const sb = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
}

/**
 * Gọi heartbeat như máy kho thật.
 *
 * Ký đúng cách của agent (`warehouse-agent/src/signing.ts`): chuỗi ký gồm
 * "v2", mã agent, phương thức, đường dẫn, băm nội dung, mốc thời gian MILI
 * giây và nonce. Ký sai một chi tiết là 401, và bài test sẽ tưởng nhầm
 * rằng cloud không khai báo phiên nào.
 */
async function agentHeartbeat(agentCode, agentSecret) {
  const body = JSON.stringify({});
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const message = [
    "v2",
    agentCode,
    "POST",
    "/api/warehouse/heartbeat",
    bodyHash,
    timestamp,
    nonce,
  ].join("\n");
  const signature = createHmac("sha256", agentSecret).update(message).digest("hex");
  const res = await fetch(`${BASE}/api/warehouse/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-code": agentCode,
      "x-agent-timestamp": timestamp,
      "x-agent-signature": signature,
      "x-agent-sig-version": "v2",
      "x-agent-nonce": nonce,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    throw new Error(`heartbeat ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, captures: json.return_captures ?? null };
}

/**
 * Đưa bàn về đóng hàng sạch sẽ trước và sau khi kiểm.
 *
 * Chạy thẳng trên database bằng khoá dịch vụ, KHÔNG qua đường sản phẩm:
 * đây là dọn dẹp của bài test, không phải thứ đang được kiểm. Nếu lần chạy
 * trước để lại người giữ treo thì vòng đầu sẽ sai oan.
 */
async function resetStation(stationId) {
  const now = new Date().toISOString();
  const { data: open } = await db
    .from("station_mode_periods")
    .select("id, mode")
    .eq("station_id", stationId)
    .is("ended_at", null);
  for (const period of open ?? []) {
    await db
      .from("station_mode_periods")
      .update({ holders: [], ended_at: now, ended_reason: "qa_reset" })
      .eq("id", period.id);
  }
  await db.from("station_mode_periods").insert({
    organization_id: ORG,
    station_id: stationId,
    mode: "outbound",
    started_by: "system",
    started_at: now,
    last_activity_at: now,
  });
}

async function stationState(stationId) {
  const { data } = await db
    .from("station_mode_periods")
    .select("id, mode, capture_state, holders, ended_at")
    .eq("station_id", stationId)
    .is("ended_at", null)
    .maybeSingle();
  return data;
}

async function main() {
  const { data: wh } = await db.from("warehouses").select("id").eq("organization_id", ORG).limit(1).single();
  const { data: station } = await db
    .from("packing_stations")
    .select("id, code, purpose")
    .eq("warehouse_id", wh.id)
    .order("code")
    .limit(1)
    .single();
  const { data: agent } = await db
    .from("warehouse_agents")
    .select("code, secret")
    .eq("organization_id", ORG)
    .limit(1)
    .single();
  console.log(`Ban thu nghiem: ${station.code} (purpose=${station.purpose}), agent=${agent.code}\n`);

  const email = `tmp.mode.${randomBytes(3).toString("hex")}@betabox.test`;
  const password = `Tmp-${randomBytes(9).toString("base64url")}`;
  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) throw createErr;
  const userId = created.user.id;

  try {
    await db.from("user_profiles").insert({
      id: userId,
      organization_id: ORG,
      role: "admin",
      full_name: "TAM kiem chuyen luong",
      status: "active",
    });
    const cookie = await login(email, password);
    const tabA = randomUUID();
    const tabB = randomUUID();
    await resetStation(station.id);

    const capture = async (action, tabId, force = false) => {
      const res = await fetch(`${BASE}/api/returns/capture`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-render-org-id": ORG },
        body: JSON.stringify({ station_ids: [station.id], action, tab_id: tabId, force }),
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, result: json.results?.[0] };
    };

    // ---- Vòng chuyển qua lại ------------------------------------------
    for (let i = 1; i <= ROUNDS; i += 1) {
      const on = await capture("open", tabA);
      const afterOn = await stationState(station.id);
      const hbOn = await agentHeartbeat(agent.code, agent.secret);
      const listedOn = (hbOn.captures ?? []).some((c) => c.station_id === station.id);

      const off = await capture("close", tabA);
      const afterOff = await stationState(station.id);
      const hbOff = await agentHeartbeat(agent.code, agent.secret);
      const listedOff = (hbOff.captures ?? []).some((c) => c.station_id === station.id);

      const ok =
        on.status === 200 &&
        afterOn?.mode === "return" &&
        afterOn?.capture_state === "active" &&
        listedOn &&
        off.status === 200 &&
        afterOff?.mode === "outbound" &&
        (afterOff?.holders ?? []).length === 0 &&
        !listedOff;
      check(
        ok,
        `vong ${String(i).padStart(2)}: BAT(mode=${afterOn?.mode},phien=${afterOn?.capture_state},heartbeat=${listedOn ? "co" : "KHONG"}) ` +
          `-> TAT(mode=${afterOff?.mode},nguoi_giu=${(afterOff?.holders ?? []).length},heartbeat=${listedOff ? "CON" : "het"})`,
      );
      if (!ok) break;
    }

    // ---- Tình huống 1: hai tab cùng bật --------------------------------
    await capture("open", tabA);
    await capture("open", tabB);
    await capture("close", tabA);
    const twoTabs = await stationState(station.id);
    check(
      twoTabs?.mode === "return" && (twoTabs?.holders ?? []).length === 1,
      `hai tab cung bat, mot tab tat -> ban VAN nhan hoan (mode=${twoTabs?.mode}, nguoi_giu=${(twoTabs?.holders ?? []).length})`,
    );
    await capture("close", tabB);
    const bothOff = await stationState(station.id);
    check(bothOff?.mode === "outbound", `tab cuoi tat -> ve dong hang (mode=${bothOff?.mode})`);

    // ---- Tình huống 2: người giữ treo (tab chết) -----------------------
    await capture("open", tabA);
    const stuck = await stationState(station.id);
    await db
      .from("station_mode_periods")
      .update({ holders: [...(stuck.holders ?? []), "module:tab-da-chet:khong-ai-go-duoc"] })
      .eq("id", stuck.id);
    const softOff = await capture("close", tabA);
    const afterSoft = await stationState(station.id);
    check(
      softOff.result?.still_held === true && afterSoft?.mode === "return",
      `tat thuong khi con nguoi giu treo -> van nhan hoan (dung nhu thiet ke)`,
    );
    const forceOff = await capture("close", tabA, true);
    const afterForce = await stationState(station.id);
    check(
      forceOff.status === 200 && afterForce?.mode === "outbound" && (afterForce?.holders ?? []).length === 0,
      `EP DUNG khi nguoi giu treo -> ve dong hang (mode=${afterForce?.mode}, nguoi_giu=${(afterForce?.holders ?? []).length})`,
    );

    // ---- Tình huống 3: bàn CHUYÊN hoàn (purpose='return') --------------
    // Bàn loại này từng kẹt vĩnh viễn: tắt phiên thì chế độ đích trùng chế
    // độ đang chạy nên kỳ không được đóng, mã phiên không đổi, và lần bật
    // sau máy kho thấy trùng mã phiên đã kết thúc nên im lặng bỏ qua.
    await db.from("packing_stations").update({ purpose: "return" }).eq("id", station.id);
    await resetStation(station.id);
    const firstOn = await capture("open", tabA);
    await capture("close", tabA, true);
    const secondOn = await capture("open", tabA);
    check(
      firstOn.result?.capture_id &&
        secondOn.result?.capture_id &&
        firstOn.result.capture_id !== secondOn.result.capture_id,
      `ban chuyen hoan: bat lai sinh MA PHIEN MOI (${String(firstOn.result?.capture_id).slice(0, 8)} -> ${String(secondOn.result?.capture_id).slice(0, 8)})`,
    );
    await capture("close", tabA, true);
    await db.from("packing_stations").update({ purpose: "outbound" }).eq("id", station.id);

    // ---- Dọn: đảm bảo bàn về đóng hàng ---------------------------------
    await capture("close", tabA, true);
    const final = await stationState(station.id);
    check(final?.mode === "outbound", `trang thai cuoi cung: ${final?.mode}`);
  } finally {
    // Trả bàn về đóng hàng dù bài kiểm sai giữa chừng — không để lại bàn
    // kẹt cho lần sau hoặc cho người đang dùng kho test.
    await db.from("packing_stations").update({ purpose: "outbound" }).eq("id", station.id);
    await resetStation(station.id).catch(() => {});
    await db.from("user_profiles").delete().eq("id", userId);
    await db.auth.admin.deleteUser(userId).catch(() => {});
    console.log(`\nda xoa tai khoan tam | TONG: ${failures ? `${failures} SAI` : "DAT HET"}`);
  }
  process.exit(failures ? 1 : 0);
}

void main();
