import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_CARDS,
  looksLikeControlCard,
  parseControlCard,
} from "../src/lib/station/control-cards.ts";

test("đọc đúng thẻ chuyển chế độ", () => {
  assert.deepEqual(parseControlCard("BETABOX:MODE:RETURN"), { kind: "mode", mode: "return" });
  assert.deepEqual(parseControlCard("BETABOX:MODE:OUTBOUND"), { kind: "mode", mode: "outbound" });
});

test("đọc đúng thẻ kết quả và thẻ kết thúc", () => {
  assert.deepEqual(parseControlCard("BETABOX:RESULT:OK"), { kind: "result", result: "ok" });
  assert.deepEqual(parseControlCard("BETABOX:RESULT:DAMAGED"), { kind: "result", result: "damaged" });
  assert.deepEqual(parseControlCard("BETABOX:RESULT:MISSING"), { kind: "result", result: "missing" });
  assert.deepEqual(parseControlCard("BETABOX:RESULT:SWAPPED"), { kind: "result", result: "swapped" });
  assert.deepEqual(parseControlCard("BETABOX:END"), { kind: "end" });
});

// Súng quét thêm ký tự thừa và trả chữ thường tuỳ cấu hình bàn phím.
test("bỏ khoảng trắng và không phân biệt hoa thường", () => {
  assert.deepEqual(parseControlCard("  betabox:mode:return \n"), { kind: "mode", mode: "return" });
});

test("mã vận đơn không bao giờ bị nhận nhầm thành thẻ", () => {
  for (const code of ["SPXVN065322002426", "862159304997", "TEST260917164354", ""]) {
    assert.equal(parseControlCard(code), null, code);
    assert.equal(looksLikeControlCard(code), false, code);
  }
});

// Thẻ in sai hoặc thẻ của bản sau: không được âm thầm làm việc khác.
test("thẻ đúng tiền tố nhưng sai giá trị thì không thực hiện gì", () => {
  for (const code of ["BETABOX:MODE:XYZ", "BETABOX:RESULT:BROKEN", "BETABOX:", "BETABOX:MODE"]) {
    assert.equal(parseControlCard(code), null, code);
    assert.equal(looksLikeControlCard(code), true, code);
  }
});

test("danh sách thẻ để in đọc được hết và không trùng nhau", () => {
  const seen = new Set<string>();
  for (const card of CONTROL_CARDS) {
    assert.ok(parseControlCard(card.code), `thẻ in không đọc được: ${card.code}`);
    assert.ok(!seen.has(card.code), `thẻ in trùng: ${card.code}`);
    seen.add(card.code);
  }
  assert.equal(CONTROL_CARDS.length, 7);
});
