import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_DEDUPE_HOURS,
  buildAlertPayload,
  collectAlertCandidates,
  selectAlertsToSend,
  sendSystemAlert,
} from "../src/lib/system/alert.ts";
import { CHECK_KEYS, type SystemCheck, type UnknownKind } from "../src/lib/system/checks.ts";

/**
 * Chống spam cảnh báo hạ tầng.
 *
 * Hai lỗi đối xứng đều chết người:
 *   - Gửi lại mỗi 15 phút → người ta tắt thông báo → lần thật không ai đọc.
 *   - Nén quá tay → sự cố mới bị nuốt.
 * Bộ test này khoá cả hai phía, và khoá luôn quy tắc "trạng thái đổi thì
 * phải gửi lại dù còn trong cửa sổ nén".
 */

const NOW = new Date("2026-08-12T10:00:00Z");

function mk(key: string, status: SystemCheck["status"]): SystemCheck {
  return { key, status, value: "v", message: "m" };
}
function mkUnknown(key: string, kind: UnknownKind): SystemCheck {
  return { key, status: "unknown", unknownKind: kind, value: "v", message: `mất nguồn ${key}` };
}

// ── client giả ─────────────────────────────────────────────────────────

interface Op {
  method: string;
  args: unknown[];
}
const CHAIN = ["select", "eq", "gte", "order", "limit", "abortSignal", "insert"];

function fakeAdmin(history: unknown[], opts: { throwOnRead?: boolean } = {}) {
  const ops: Op[] = [];
  const q: Record<string, unknown> = {
    then: (res: (v: unknown) => void) =>
      res(
        opts.throwOnRead
          ? { data: null, error: { message: "history unavailable" } }
          : { data: history, error: null },
      ),
  };
  for (const m of CHAIN) {
    q[m] = (...args: unknown[]) => {
      ops.push({ method: m, args });
      return q;
    };
  }
  return { ops, client: { from: () => q } };
}

/** Thay global fetch để không gọi Lark thật. */
function stubFetch(behaviour: "ok" | "lark_error" | "network_error") {
  const calls: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    if (behaviour === "network_error") throw new Error("ECONNRESET");
    const body =
      behaviour === "ok"
        ? JSON.stringify({ code: 0, msg: "success" })
        : JSON.stringify({ code: 19024, msg: "invalid webhook" });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const WEBHOOK = "https://open.larksuite.com/open-apis/bot/v2/hook/TEST";

// ═══════════════════════════════════════════════════════════════════════
// collectAlertCandidates — cái gì đáng thành tin
// ═══════════════════════════════════════════════════════════════════════

test("ok không bao giờ thành tin", () => {
  const out = collectAlertCandidates([mk("a", "ok"), mk("b", "ok")]);
  assert.deepEqual(out, []);
});

test("warn/crit luôn thành tin", () => {
  const out = collectAlertCandidates([mk("a", "ok"), mk("c", "warn"), mk("d", "crit")]);
  assert.deepEqual(out.map((c) => c.key), ["c", "d"]);
});

test("unknown CẤU TRÚC không gửi — dù mục đó có bật cờ", () => {
  // camera_probe bật alertOnUnknown, nhưng trạng thái "camera đứng hình"
  // là đứng yên chứ không phải hỏng. Gửi mỗi 6 giờ = dạy người trực phớt lờ.
  const out = collectAlertCandidates([mkUnknown(CHECK_KEYS.cameraProbe, "structural")]);
  assert.deepEqual(out, []);
});

test("unknown SỰ CỐ của mục có cờ → gửi", () => {
  const out = collectAlertCandidates([mkUnknown(CHECK_KEYS.cronCleanup, "incident")]);
  assert.deepEqual(out.map((c) => c.key), [CHECK_KEYS.cronCleanup]);
  assert.equal(out[0].status, "unknown");
});

test("unknown SỰ CỐ của mục KHÔNG có cờ (egress, disk kho) → im", () => {
  const out = collectAlertCandidates([
    mkUnknown(CHECK_KEYS.egress, "incident"),
    mkUnknown(CHECK_KEYS.warehouseDisk, "incident"),
  ]);
  assert.deepEqual(out, [], "hai mục này luôn unknown theo thiết kế, không được thành nguồn nhiễu");
});

test("từ 2 mục mất nguồn trở lên → GỘP một tin crit, không bắn tin rời", () => {
  const out = collectAlertCandidates([
    mkUnknown(CHECK_KEYS.cronCleanup, "incident"),
    mkUnknown(CHECK_KEYS.agentHeartbeat, "incident"),
    mkUnknown(CHECK_KEYS.cameraProbe, "incident"),
  ]);
  assert.equal(out.length, 1, "ba tin cho một nguyên nhân là cách nhanh nhất bị tắt thông báo");
  assert.equal(out[0].key, "data_sources");
  assert.equal(out[0].status, "crit");
  assert.match(out[0].message, /nghi Supabase\/DB/);
  assert.match(out[0].value, /3 mục/);
});

test("tin gộp đứng TRƯỚC các mục xấu khác — nó là lời giải thích cho chúng", () => {
  const out = collectAlertCandidates([
    mkUnknown(CHECK_KEYS.cronCleanup, "incident"),
    mkUnknown(CHECK_KEYS.agentHeartbeat, "incident"),
    mk(CHECK_KEYS.vps, "warn"),
  ]);
  assert.deepEqual(out.map((c) => c.key), ["data_sources", CHECK_KEYS.vps]);
});

test("nửa âm: 1 mục mất nguồn thì KHÔNG gộp, gửi đúng mục đó", () => {
  const out = collectAlertCandidates([
    mkUnknown(CHECK_KEYS.agentHeartbeat, "incident"),
    mkUnknown(CHECK_KEYS.egress, "structural"),
  ]);
  assert.deepEqual(out.map((c) => c.key), [CHECK_KEYS.agentHeartbeat]);
});

// ═══════════════════════════════════════════════════════════════════════
// selectAlertsToSend — luật nén
// ═══════════════════════════════════════════════════════════════════════

test("cùng mục cùng trạng thái đã gửi trong cửa sổ → nén", () => {
  const out = selectAlertsToSend([mk("c", "warn")], new Map([["c", "warn"]]));
  assert.equal(out.length, 0);
});

test("trạng thái ĐỔI warn → crit thì gửi lại ngay, dù còn trong cửa sổ", () => {
  const out = selectAlertsToSend([mk("c", "crit")], new Map([["c", "warn"]]));
  assert.deepEqual(out.map((c) => c.key), ["c"], "nặng lên là tin mới, không được nén");
});

test("mục khác đang đỏ không bị mục đã gửi che", () => {
  const out = selectAlertsToSend(
    [mk("c", "warn"), mk("d", "crit")],
    new Map([["c", "warn"]]),
  );
  assert.deepEqual(out.map((x) => x.key), ["d"]);
});

test("tin gộp cũng bị nén như mọi tin khác (không nã mỗi 15 phút khi DB sập lâu)", () => {
  const candidates = collectAlertCandidates([
    mkUnknown(CHECK_KEYS.cronCleanup, "incident"),
    mkUnknown(CHECK_KEYS.agentHeartbeat, "incident"),
  ]);
  const out = selectAlertsToSend(candidates, new Map([["data_sources", "crit"]]));
  assert.deepEqual(out, []);
});

// ═══════════════════════════════════════════════════════════════════════
// sendSystemAlert — đường đầy đủ
// ═══════════════════════════════════════════════════════════════════════

test("tất cả ok → KHÔNG gọi Lark (im lặng là bình thường)", async () => {
  const f = stubFetch("ok");
  try {
    const admin = fakeAdmin([]);
    const res = await sendSystemAlert({
      admin: admin.client as never,
      checks: [mk("a", "ok"), mk("b", "ok")],
      now: NOW,
      webhookUrl: WEBHOOK,
    });
    assert.equal(res.sent, null);
    assert.equal(f.calls.length, 0, "không được gửi gì khi mọi thứ bình thường");
  } finally {
    f.restore();
  }
});

test("có crit → gửi, ghi lại mục đã gửi để lần sau nén", async () => {
  const f = stubFetch("ok");
  try {
    const admin = fakeAdmin([]);
    const res = await sendSystemAlert({
      admin: admin.client as never,
      checks: [mk("cron_cleanup", "crit"), mk("x", "ok")],
      now: NOW,
      webhookUrl: WEBHOOK,
    });
    assert.equal(res.sent, true);
    assert.deepEqual(res.alerted, [{ key: "cron_cleanup", status: "crit" }]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, WEBHOOK);
  } finally {
    f.restore();
  }
});

test("lịch sử 1 giờ trước có cùng mục cùng trạng thái → không gọi Lark", async () => {
  const f = stubFetch("ok");
  try {
    const admin = fakeAdmin([
      { detail: { alerted: [{ key: "cron_cleanup", status: "crit" }] }, ran_at: NOW.toISOString() },
    ]);
    const res = await sendSystemAlert({
      admin: admin.client as never,
      checks: [mk("cron_cleanup", "crit")],
      now: NOW,
      webhookUrl: WEBHOOK,
    });
    assert.equal(res.sent, null);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("cửa sổ nén hỏi DB đúng 6 giờ, không phải con số khác", async () => {
  const f = stubFetch("ok");
  try {
    const admin = fakeAdmin([]);
    await sendSystemAlert({
      admin: admin.client as never,
      checks: [mk("k", "warn")],
      now: NOW,
      webhookUrl: WEBHOOK,
    });
    const gte = admin.ops.find((o) => o.method === "gte");
    assert.ok(gte, "phải lọc theo ran_at");
    assert.equal(gte.args[0], "ran_at");
    const expected = new Date(NOW.getTime() - ALERT_DEDUPE_HOURS * 3_600_000).toISOString();
    assert.equal(gte.args[1], expected);
  } finally {
    f.restore();
  }
});

test("ca nguồn hỏng: không đọc được lịch sử → VẪN gửi, không nuốt cảnh báo", async () => {
  const f = stubFetch("ok");
  try {
    const admin = fakeAdmin([], { throwOnRead: true });
    const res = await sendSystemAlert({
      admin: admin.client as never,
      checks: [mk("k", "crit")],
      now: NOW,
      webhookUrl: WEBHOOK,
    });
    assert.equal(res.sent, true, "thà lặp một tin còn hơn im lặng lúc có sự cố");
  } finally {
    f.restore();
  }
});

test("chưa cấu hình webhook → sent=false + nói rõ thiếu biến nào", async () => {
  const admin = fakeAdmin([]);
  const res = await sendSystemAlert({
    admin: admin.client as never,
    checks: [mk("k", "crit")],
    now: NOW,
    webhookUrl: null,
  });
  assert.equal(res.sent, false);
  assert.match(res.error ?? "", /LARK_INFRA_WEBHOOK_URL/);
  assert.deepEqual(res.alerted, []);
});

test("Lark trả lỗi → KHÔNG ghi là đã gửi (lần sau còn thử lại)", async () => {
  const f = stubFetch("lark_error");
  try {
    const admin = fakeAdmin([]);
    const res = await sendSystemAlert({
      admin: admin.client as never,
      checks: [mk("k", "crit")],
      now: NOW,
      webhookUrl: WEBHOOK,
    });
    assert.equal(res.sent, false);
    assert.match(res.error ?? "", /lark_code_19024/);
    assert.deepEqual(res.alerted, [], "ghi 'đã gửi' khi gửi hụt = bộ chống spam tự nuốt cảnh báo");
  } finally {
    f.restore();
  }
});

test("mạng rớt khi gọi Lark → không ném ra ngoài route", async () => {
  const f = stubFetch("network_error");
  try {
    const admin = fakeAdmin([]);
    const res = await sendSystemAlert({
      admin: admin.client as never,
      checks: [mk("k", "crit")],
      now: NOW,
      webhookUrl: WEBHOOK,
    });
    assert.equal(res.sent, false);
    assert.match(res.error ?? "", /fetch_error/);
  } finally {
    f.restore();
  }
});

test("kịch bản Supabase sập: chạy thật loạt kiểm → đúng MỘT tin crit gộp", async () => {
  // Đây là lỗ 10/08 được bịt: trước đây cả loạt chuyển unknown và không
  // ai được báo gì.
  const { runSystemChecks } = await import("../src/lib/system/checks.ts");
  const dead = {
    from: () => {
      const q: Record<string, unknown> = {
        then: (res: (v: unknown) => void) =>
          res({ data: null, error: { message: "could not connect to server" } }),
      };
      for (const m of CHAIN) q[m] = () => q;
      return q;
    },
  };
  const { checks } = await runSystemChecks({
    client: dead as never,
    now: NOW,
    os: { totalmem: () => 8, freemem: () => 4 },
    statfs: async () => {
      throw new Error("EIO");
    },
  });
  const candidates = collectAlertCandidates(checks);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].key, "data_sources");
  assert.equal(candidates[0].status, "crit");
  assert.match(
    candidates[0].value,
    /7 mục/,
    "7 mục đo được đều mất nguồn (cron dọn clip, cron segment mồ côi, agent, camera, ghi hình, clip, vps); egress + storage + disk kho vốn đã không đo được nên không tính",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Nội dung tin
// ═══════════════════════════════════════════════════════════════════════

test("card Lark: nêu mục đỏ, kèm số mục bình thường và chưa đo được", () => {
  const payload = buildAlertPayload(
    [{ key: "agent_heartbeat", status: "crit", value: "KHO-A: 19 giờ", message: "Agent im 19 giờ." }],
    [
      mk("supabase_egress", "unknown"),
      mk("cron_cleanup", "ok"),
      { key: "agent_heartbeat", status: "crit", value: "x", message: "y" },
      mk("camera_probe", "ok"),
      mk("vps_resources", "ok"),
      mk("warehouse_disk", "unknown"),
    ],
    "https://betabox.betacom.agency/dashboard/system",
  ) as { card: { header: { title: { content: string } }; elements: Array<{ text?: { content: string } }> } };

  const title = payload.card.header.title.content;
  assert.match(title, /NGHIÊM TRỌNG/, "có crit thì tiêu đề phải nói mức nặng");
  const body = payload.card.elements[0].text?.content ?? "";
  assert.match(body, /agent_heartbeat/);
  assert.match(body, /19 giờ/);
  assert.match(body, /3 mục bình thường/);
  assert.match(body, /2 mục chưa đo được/);
});

test("card Lark: chỉ có warn thì tiêu đề KHÔNG nói nghiêm trọng", () => {
  const payload = buildAlertPayload([mk("k", "warn")], [mk("k", "warn")], null) as {
    card: { header: { title: { content: string } } };
  };
  assert.doesNotMatch(payload.card.header.title.content, /NGHIÊM TRỌNG/);
});
