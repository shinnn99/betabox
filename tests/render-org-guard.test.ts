import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRenderOrg,
  isWriteMethod,
} from "../src/lib/supabase/render-org-guard.ts";

/**
 * Vế 4 — chống ghi-nhầm org giữa hai tab.
 *
 * Sự cố 2026-09-16: tab mở sẵn org Đại Kim, cookie đã đổi sang org Demo,
 * form camera submit bằng `fetch` trần (không header) → guard cũ cho qua →
 * camera kho thật bị ghi đè, mất ghi hình ~24 giờ.
 *
 * Hai vế bắt buộc, không lấy vế này làm chứng cho vế kia:
 *   - DƯƠNG: ghi hợp lệ trong cùng org vẫn phải đi lọt.
 *   - ÂM:    ghi khi ngữ cảnh lệch HOẶC thiếu bằng chứng ngữ cảnh → chặn.
 */

const ORG_DAI_KIM = "e3cb7cd1-e869-4d55-936d-5bcb1a1467b8";
const ORG_DEMO = "00000000-0000-0000-0000-000000000001";

// ── isWriteMethod ──────────────────────────────────────────────────────────

test("isWriteMethod: GET/HEAD/OPTIONS là đọc", () => {
  assert.equal(isWriteMethod("GET"), false);
  assert.equal(isWriteMethod("HEAD"), false);
  assert.equal(isWriteMethod("OPTIONS"), false);
});

test("isWriteMethod: POST/PUT/PATCH/DELETE là ghi", () => {
  assert.equal(isWriteMethod("POST"), true);
  assert.equal(isWriteMethod("PUT"), true);
  assert.equal(isWriteMethod("PATCH"), true);
  assert.equal(isWriteMethod("DELETE"), true);
});

test("isWriteMethod: không phân biệt hoa thường", () => {
  assert.equal(isWriteMethod("put"), true);
  assert.equal(isWriteMethod("get"), false);
});

// ── VẾ DƯƠNG: ghi hợp lệ phải lọt ──────────────────────────────────────────

test("dương: PUT cùng org → allow", () => {
  assert.deepEqual(
    evaluateRenderOrg("PUT", ORG_DAI_KIM, ORG_DAI_KIM),
    { kind: "allow" },
  );
});

test("dương: POST/DELETE cùng org → allow", () => {
  assert.deepEqual(evaluateRenderOrg("POST", ORG_DEMO, ORG_DEMO), {
    kind: "allow",
  });
  assert.deepEqual(evaluateRenderOrg("DELETE", ORG_DEMO, ORG_DEMO), {
    kind: "allow",
  });
});

test("dương: GET không cần header → skip", () => {
  assert.deepEqual(evaluateRenderOrg("GET", null, ORG_DAI_KIM), {
    kind: "skip",
  });
});

test("dương: GET lệch org vẫn skip — đọc lệch không hỏng dữ liệu", () => {
  assert.deepEqual(evaluateRenderOrg("GET", ORG_DEMO, ORG_DAI_KIM), {
    kind: "skip",
  });
});

// ── VẾ ÂM: đúng hình dạng sự cố 2026-09-16 ─────────────────────────────────

test("âm: tab render org Demo, ghi vào org Đại Kim → mismatch", () => {
  assert.deepEqual(
    evaluateRenderOrg("PUT", ORG_DEMO, ORG_DAI_KIM),
    { kind: "mismatch" },
  );
});

test("âm: tab render org Đại Kim, ghi vào org Demo → mismatch", () => {
  assert.deepEqual(
    evaluateRenderOrg("PUT", ORG_DAI_KIM, ORG_DEMO),
    { kind: "mismatch" },
  );
});

/**
 * Đây là ca đã cắn thật và guard cũ CHO QUA.
 *
 * `fetch` trần không gắn `x-render-org-id`. Bản fail-open coi "vắng header"
 * là "chắc GET" rồi bỏ kiểm — nên PUT ghi thẳng vào org của tab cũ.
 */
test("âm: PUT thiếu header (fetch trần) → missing, KHÔNG được cho qua", () => {
  assert.deepEqual(evaluateRenderOrg("PUT", null, ORG_DAI_KIM), {
    kind: "missing",
  });
});

test("âm: POST/DELETE thiếu header → missing", () => {
  assert.deepEqual(evaluateRenderOrg("POST", undefined, ORG_DEMO), {
    kind: "missing",
  });
  assert.deepEqual(evaluateRenderOrg("DELETE", null, ORG_DEMO), {
    kind: "missing",
  });
});

test("âm: header rỗng / chỉ khoảng trắng → missing, không lọt", () => {
  assert.deepEqual(evaluateRenderOrg("PUT", "", ORG_DAI_KIM), {
    kind: "missing",
  });
  assert.deepEqual(evaluateRenderOrg("PUT", "   ", ORG_DAI_KIM), {
    kind: "missing",
  });
});

test("âm: không ca ghi nào trả 'skip' — skip chỉ dành cho đọc", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const header of [null, undefined, "", ORG_DEMO, ORG_DAI_KIM]) {
      const verdict = evaluateRenderOrg(method, header, ORG_DAI_KIM);
      assert.notEqual(
        verdict.kind,
        "skip",
        `${method} + header=${String(header)} không được bỏ qua kiểm tra`,
      );
    }
  }
});
