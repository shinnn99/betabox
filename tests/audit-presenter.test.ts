import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  presentAudit,
  extractChanges,
  resolveTargetLabel,
  knownActions,
  type AuditRowInput,
} from "../src/lib/audit-view/presenter.ts";

/**
 * Trang Nhật ký hệ thống là nơi chủ kho đọc, không phải nơi lập trình viên
 * đọc log. Bộ test này giữ đúng một điều: không có dòng nào lọt ra màn hình
 * dưới dạng mã kỹ thuật thô.
 */

function row(over: Partial<AuditRowInput> = {}): AuditRowInput {
  return {
    id: "1",
    actor_email: "an@betacom.vn",
    action: "camera.delete",
    target_type: "camera",
    target_id: "3f2a1b9c-0000-0000-0000-000000000000",
    metadata: {},
    created_at: "2026-09-25T07:30:00Z",
    ...over,
  };
}

test("câu đầy đủ dùng tên camera, không dùng UUID", () => {
  const p = presentAudit(row({ target_name: "Cổng sau" }));
  assert.equal(p.sentence, "an@betacom.vn đã xoá camera “Cổng sau”");
  assert.ok(!p.sentence.includes("3f2a1b9c"));
  assert.ok(!p.sentence.includes("camera.delete"));
});

test("không tra được tên thì vẫn ra câu đọc được, không lộ UUID", () => {
  const p = presentAudit(row({ target_name: null }));
  assert.equal(p.sentence, "an@betacom.vn đã xoá camera");
  assert.ok(!p.sentence.includes("3f2a1b9c"));
});

test("đối tượng đã xoá: lấy tên từ metadata đã chụp lại", () => {
  const p = presentAudit(
    row({
      action: "staff.delete",
      target_type: "staff",
      target_name: null,
      metadata: { staff_code: "NV007", full_name: "Trần B" },
    }),
  );
  assert.equal(p.targetLabel, "Trần B");
  assert.equal(p.sentence, "an@betacom.vn đã xoá nhân viên “Trần B”");
});

test("action lạ vẫn ra nhãn đọc được, không ra mã trần", () => {
  const p = presentAudit(
    row({ action: "something_new.delete", target_type: "camera" }),
  );
  assert.equal(p.title, "Xoá camera");
  assert.equal(p.severity, "critical");
  assert.ok(!p.title.includes("something_new"));
});

test("action lạ hoàn toàn không làm vỡ UI", () => {
  const p = presentAudit(
    row({ action: "abc.xyz", target_type: null, target_name: null }),
  );
  assert.ok(p.title.length > 0);
  assert.ok(p.sentence.startsWith("an@betacom.vn "));
});

test("thiếu người thực hiện thì ghi Hệ thống", () => {
  const p = presentAudit(row({ actor_email: null }));
  assert.ok(p.sentence.startsWith("Hệ thống "));
});

test("changes dạng from/to dịch tên trường sang tiếng Việt", () => {
  const changes = extractChanges({
    changes: {
      ip: { from: "192.168.1.236", to: "192.168.31.12" },
      rtsp_port: { from: 554, to: 8554 },
    },
  });
  assert.deepEqual(changes, [
    { field: "ip", label: "Địa chỉ IP", from: "192.168.1.236", to: "192.168.31.12" },
    { field: "rtsp_port", label: "Cổng RTSP", from: "554", to: "8554" },
  ]);
});

test("changes dạng chỉ-giá-trị-mới không bịa vế từ", () => {
  const changes = extractChanges({ changes: { full_name: "Nguyễn C" } });
  assert.deepEqual(changes, [
    { field: "full_name", label: "Họ tên", from: "—", to: "Nguyễn C" },
  ]);
});

test("vai trò và trạng thái hiện bằng tiếng Việt", () => {
  const changes = extractChanges({
    changes: {
      role: { from: "viewer", to: "warehouse_manager" },
      status: { from: "active", to: "inactive" },
    },
  });
  assert.equal(changes[0].from, "Chỉ xem");
  assert.equal(changes[0].to, "Trưởng kho");
  assert.equal(changes[1].to, "Ngừng dùng");
});

test("giá trị rỗng hiện (trống), không hiện null", () => {
  const changes = extractChanges({ changes: { location: { from: null, to: "Bàn 01" } } });
  assert.equal(changes[0].from, "(trống)");
});

test("metadata không có changes thì không vỡ", () => {
  assert.deepEqual(extractChanges(null), []);
  assert.deepEqual(extractChanges({}), []);
  assert.deepEqual(extractChanges({ changes: "hỏng" }), []);
  assert.deepEqual(extractChanges({ changes: ["a"] }), []);
});

test("ghi chú kể previous_role và cảnh báo khoá đăng nhập", () => {
  const p = presentAudit(
    row({
      action: "user.update",
      metadata: { previous_role: "admin", auth_ban_failed: "timeout" },
    }),
  );
  assert.ok(p.notes.some((n) => n.includes("Quản trị")));
  assert.ok(p.notes.some((n) => n.includes("chưa áp được")));
});

test("xoá và cấp lại mã bí mật xếp mức quan trọng", () => {
  assert.equal(presentAudit(row({ action: "user.delete" })).severity, "critical");
  assert.equal(
    presentAudit(row({ action: "warehouse_agent.reset_secret" })).severity,
    "critical",
  );
  assert.equal(
    presentAudit(row({ action: "camera.test_connection.enqueued" })).severity,
    "info",
  );
});

/**
 * Các ca dưới đây lấy từ dữ liệu audit_logs THẬT (đối chiếu 25/09/2026),
 * không phải ca tự nghĩ ra — nên chúng phản ánh thứ người dùng đang thấy.
 */
test("khối JSON lớn không đổ ra màn hình", () => {
  const changes = extractChanges({
    changes: { config_json: { from: { a: 1 }, to: { a: 2, b: [1, 2, 3] } } },
  });
  assert.equal(changes[0].label, "Cấu hình thiết bị");
  assert.equal(changes[0].to, "(đã thay đổi)");
  assert.ok(!JSON.stringify(changes).includes('"b"'));
});

test("URL webhook Lark không bị bày ra (mang token gửi tin)", () => {
  const changes = extractChanges({
    changes: {
      notify_lark_webhook_url: {
        from: null,
        to: "https://open.larksuite.com/open-apis/bot/v2/hook/SECRET-TOKEN",
      },
    },
  });
  assert.ok(!JSON.stringify(changes).includes("SECRET-TOKEN"));
  assert.equal(changes[0].to, "(đã thay đổi)");
});

test("trường cấu hình tổ chức có nhãn tiếng Việt", () => {
  const changes = extractChanges({
    changes: { return_retention_days: { from: null, to: 10 }, scan_source: { from: "a", to: "b" } },
  });
  assert.equal(changes[0].label, "Số ngày lưu video hoàn hàng");
  assert.equal(changes[1].label, "Nguồn quét mã");
});

test("action lịch sử không còn trong mã nguồn vẫn có nhãn", () => {
  // Route đã đổi tên nhưng dữ liệu cũ vẫn nằm trong bảng và vẫn hiện ra.
  for (const action of [
    "camera.recording.sync_files",
    "camera.test_connection",
    "camera.recording.start",
    "order_proof.clip.generate",
  ]) {
    const p = presentAudit(row({ action }));
    assert.ok(!p.title.includes("."), `${action} lọt mã trần: ${p.title}`);
  }
});

test("resolveTargetLabel ưu tiên tên tra ở server hơn metadata", () => {
  const label = resolveTargetLabel(
    row({ target_name: "Tên thật", metadata: { full_name: "Tên cũ" } }),
  );
  assert.equal(label, "Tên thật");
});

/**
 * Bài canh quan trọng nhất: thêm `audit({ action: "x.y" })` ở route mới mà
 * quên khai nhãn thì người dùng sẽ thấy mã trần. Test này bắt tại chỗ.
 */
test("mọi action được ghi ở route tổ chức đều đã có nhãn tiếng Việt", () => {
  const roots = ["src/app/api", "src/lib"];
  const found = new Set<string>();

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const src = readFileSync(full, "utf8");
      // Chỉ bắt lời gọi audit() per-tenant; platform dùng logPlatformAudit
      // và có trang riêng nên không tính vào đây.
      if (!src.includes("@/lib/audit")) continue;
      for (const m of src.matchAll(/action:\s*"([a-z_]+\.[a-z_.+]+)"/g)) {
        found.add(m[1]);
      }
    }
  };
  for (const r of roots) walk(r);

  // Cửa ngõ: nếu quét không ra gì thì test này vô nghĩa — fail to.
  assert.ok(found.size >= 20, `quét được quá ít action: ${found.size}`);

  const known = new Set(knownActions());
  const missing = [...found].filter((a) => !known.has(a));
  assert.deepEqual(
    missing,
    [],
    `Action chưa khai nhãn trong src/lib/audit-view/presenter.ts: ${missing.join(", ")}`,
  );
});
