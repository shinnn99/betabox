import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuditRow,
  logPlatformAuditWith,
  type PlatformAuditWriter,
} from "../src/lib/platform/audit-core";

/**
 * Test HIGH-7: platform audit core.
 *
 * Chạy: pnpm exec tsx --test tests/platform-audit-core.test.ts
 */

test("buildAuditRow: map đầy đủ field, default null cho optional", () => {
  const row = buildAuditRow({
    actorUserId: "user-1",
    actorEmail: "a@b.com",
    impersonatingOrgId: "org-x",
    action: "platform.org.impersonate.start",
    targetType: "organization",
    targetId: "org-x",
    metadata: { note: "test" },
  });
  assert.deepEqual(row, {
    actor_user_id: "user-1",
    actor_email: "a@b.com",
    impersonating_org_id: "org-x",
    action: "platform.org.impersonate.start",
    target_type: "organization",
    target_id: "org-x",
    metadata: { note: "test" },
    // B1.2 snapshot fields — actor_email_snapshot fallback từ actor_email
    // khi không supply riêng, giữ để bảo toàn khi FK SET NULL sau này.
    actor_email_snapshot: "a@b.com",
    actor_role_snapshot: null,
    target_organization_name_snapshot: null,
  });
});

test("buildAuditRow: B1.2 snapshot fields — caller supply riêng ưu tiên hơn fallback", () => {
  const row = buildAuditRow({
    actorUserId: "user-1",
    actorEmail: "current@b.com",
    action: "platform.org.impersonate.start",
    actorEmailSnapshot: "at-time-of-event@b.com",
    actorRoleSnapshot: "platform_owner",
    targetOrganizationNameSnapshot: "Acme Corp",
  });
  assert.equal(row.actor_email_snapshot, "at-time-of-event@b.com");
  assert.equal(row.actor_role_snapshot, "platform_owner");
  assert.equal(row.target_organization_name_snapshot, "Acme Corp");
});

test("buildAuditRow: KHÔNG supply snapshot nào → snapshot null (không tự bịa)", () => {
  const row = buildAuditRow({
    actorUserId: "user-1",
    action: "platform.admin.add",
  });
  assert.equal(row.actor_email_snapshot, null);
  assert.equal(row.actor_role_snapshot, null);
  assert.equal(row.target_organization_name_snapshot, null);
});

test("buildAuditRow: optional fields → null", () => {
  const row = buildAuditRow({
    actorUserId: "user-1",
    action: "platform.admin.add",
  });
  assert.equal(row.actor_email, null);
  assert.equal(row.impersonating_org_id, null);
  assert.equal(row.target_type, null);
  assert.equal(row.target_id, null);
  assert.equal(row.metadata, null);
});

test("logPlatformAuditWith: writer ok → { ok: true }", async () => {
  const seen: Record<string, unknown>[] = [];
  const writer: PlatformAuditWriter = {
    async insertRow(row) {
      seen.push(row);
      return { error: null };
    },
  };
  const res = await logPlatformAuditWith(writer, {
    actorUserId: "u1",
    action: "test.action",
  });
  assert.equal(res.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, "test.action");
});

test("logPlatformAuditWith: writer trả error → { ok: false, error }", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => logs.push(String(msg));
  try {
    const writer: PlatformAuditWriter = {
      async insertRow() {
        return { error: { code: "42501", message: "permission denied" } };
      },
    };
    const res = await logPlatformAuditWith(writer, {
      actorUserId: "u1",
      action: "platform.org.impersonate.start",
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "permission denied");
    // Log ra có code + message
    const joined = logs.join("\n");
    assert.match(joined, /\[platform_audit_log\]/);
    assert.match(joined, /42501/);
    assert.match(joined, /permission denied/);
  } finally {
    console.error = orig;
  }
});

test("logPlatformAuditWith: KHÔNG log metadata raw (không rò)", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => logs.push(String(msg));
  try {
    const writer: PlatformAuditWriter = {
      async insertRow() {
        return { error: { code: "23505", message: "unique_violation" } };
      },
    };
    await logPlatformAuditWith(writer, {
      actorUserId: "u1",
      action: "test",
      metadata: { secret_token: "SHOULD_NOT_APPEAR_IN_LOG_XYZ" },
    });
    const joined = logs.join("\n");
    assert.doesNotMatch(
      joined,
      /SHOULD_NOT_APPEAR_IN_LOG_XYZ/,
      "metadata raw không được lộ ra log",
    );
  } finally {
    console.error = orig;
  }
});
