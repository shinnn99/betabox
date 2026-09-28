import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEventFailure, shouldDiagnoseHttpStatus } from "@/lib/diagnostics/event-failure";

const NOW = new Date("2026-09-28T09:00:00.000Z");

test("mọi HTTP 4xx/5xx — gồm 422 — đều gọi chẩn đoán sau event lỗi", () => {
  for (const status of [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]) {
    assert.equal(shouldDiagnoseHttpStatus(status), true, `HTTP ${status}`);
  }
  for (const status of [200, 201, 204, 301, 399, 600]) {
    assert.equal(shouldDiagnoseHttpStatus(status), false, `HTTP ${status}`);
  }
});

test("event lỗi được bóc giới hạn và không nhận raw message/body", () => {
  const parsed = parseEventFailure(
    {
      agent_id: "11111111-1111-1111-1111-111111111111",
      event_name: "camera.test_connection.timeout",
      target_type: "camera",
      target_id: "22222222-2222-2222-2222-222222222222",
      failure_kind: "timeout",
      error_code: "upstream_timeout",
      occurred_at: "2026-09-28T15:55:00+07:00",
      correlation_id: "33333333-3333-4333-8333-333333333333",
      raw_message: "rtsp://admin:secret@192.168.1.10/stream",
      body: { password: "secret" },
    },
    NOW,
  );
  assert.ok(parsed);
  assert.equal(parsed.eventName, "camera.test_connection.timeout");
  assert.equal(parsed.occurredAt, "2026-09-28T08:55:00.000Z");
  assert.equal("raw_message" in parsed, false);
  assert.equal("body" in parsed, false);
});

test("event giả / loại HTTP không khớp dải trạng thái bị từ chối", () => {
  const base = {
    agent_id: "agent-1",
    event_name: "camera.test",
    correlation_id: "correlation-1",
  };
  assert.equal(parseEventFailure({ ...base, failure_kind: "validation" }, NOW), null);
  assert.equal(parseEventFailure({ ...base, failure_kind: "http_5xx", http_status: 409 }, NOW), null);
  assert.equal(parseEventFailure({ ...base, failure_kind: "http_4xx", http_status: 503 }, NOW), null);
  assert.equal(parseEventFailure({ ...base, failure_kind: "http_4xx", http_status: 422 }, NOW)?.httpStatus, 422);
  assert.equal(parseEventFailure({ ...base, failure_kind: "http_5xx", http_status: 503 }, NOW)?.httpStatus, 503);
  assert.equal(parseEventFailure({ ...base, failure_kind: "timeout", event_name: "x có khoảng trắng" }, NOW), null);
});

test("dây nối: button lỗi -> command đúng agent -> agent trả correlation -> platform xem được", () => {
  const client = readFileSync("src/components/devices/CameraTestConnectionModal.tsx", "utf8");
  const apiFetch = readFileSync("src/lib/api-fetch.tsx", "utf8");
  const route = readFileSync("src/app/api/event-diagnostics/route.ts", "utf8");
  const agent = readFileSync("warehouse-agent/src/index.ts", "utf8");
  const fleetApi = readFileSync("src/app/api/platform/agents/route.ts", "utf8");
  const fleetUi = readFileSync("src/components/platform/FleetTable.tsx", "utf8");

  assert.match(client, /camera\.test_connection\.timeout/);
  assert.match(client, /reportEventFailure/);
  assert.match(apiFetch, /res\.status >= 500 \? "http_5xx" : "http_4xx"/);
  assert.match(route, /\.eq\("organization_id", ctx\.organizationId\)/, "không được chẩn đoán agent org khác");
  assert.match(route, /CAPABILITY\.diagnostics/);
  assert.match(route, /type: "collect_diagnostics"/);
  assert.match(route, /payload: \{ trigger \}/);
  assert.match(route, /\.contains\("payload"/, "một event đang quét không được đẻ lệnh trùng");
  assert.match(agent, /command\.payload\.trigger/);
  assert.match(agent, /recording\.camera_id === targetId/);
  assert.match(fleetApi, /latestDiagnostic/);
  assert.match(fleetUi, /Xem quét sau lỗi/);
});

test("không còn route polling platform để tự quét toàn hệ thống khi mở trang", () => {
  assert.equal(
    (() => {
      try {
        readFileSync("src/app/api/platform/incidents/refresh/route.ts", "utf8");
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
});
