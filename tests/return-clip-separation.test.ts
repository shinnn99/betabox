import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { bucketPathFor } from "../src/lib/watch/config.ts";
import { buildProofClipFileName } from "../src/lib/order-proof/clip-file-name.ts";
import { returnStripLabel } from "../src/lib/agent-commands/enqueue.ts";
import {
  RETURN_CLIP_SETTLE_SECONDS,
  returnClipSettled,
} from "../src/lib/station/return-clip-requests.ts";

/**
 * Chạy thử đầu-cuối trên agent 0.10.0 (21/09/2026) lộ ra mấy chỗ mà mọi
 * kiểm thử trước đều bỏ lọt. Mỗi test dưới đây khoá lại đúng một chỗ.
 */

const ORG = "00000000-0000-0000-0000-000000000001";
const PE = "883c0686-c7d9-4127-b8a3-ccc9122e645e";
const CLIP = "27e2f06d-f47d-472b-aad1-75cd293e34bd";

// ---------------------------------------------------------------------------
// Video đẩy lên Supabase phải phân biệt được đóng hàng / hoàn hàng.
// ---------------------------------------------------------------------------

test("đường dẫn bucket: kiện hoàn nằm thư mục riêng, đơn đi giữ nguyên", () => {
  assert.equal(bucketPathFor(ORG, PE, CLIP, "return"), `${ORG}/hoan/${PE}/${CLIP}.mp4`);
  assert.equal(bucketPathFor(ORG, PE, CLIP, "outbound"), `${ORG}/${PE}/${CLIP}.mp4`);
  // Gọi thiếu loại (code cũ) = đơn đi như trước — không đổi đường dẫn đơn đi.
  assert.equal(bucketPathFor(ORG, PE, CLIP), `${ORG}/${PE}/${CLIP}.mp4`);
});

test("hai route tải lên cùng một công thức đường dẫn, không tự ghép tay", () => {
  for (const f of [
    "src/app/api/agent/clip-upload-url/route.ts",
    "src/app/api/agent/clip-upload-complete/route.ts",
  ]) {
    const source = readFileSync(f, "utf8");
    assert.ok(source.includes("asEventKind(pe?.event_kind)"), `${f} phải truyền loại lượt vào bucketPathFor`);
  }
  const complete = readFileSync("src/app/api/agent/clip-upload-complete/route.ts", "utf8");
  assert.ok(
    complete.includes(`bucketPath.slice(0, bucketPath.lastIndexOf("/"))`),
    "bước xác minh phải lấy thư mục từ chính bucketPath — ghép tay là hai công thức chực lệch",
  );
});

test("tên file tải về: kiện hoàn có tiền tố HOAN-, đơn đi như cũ", () => {
  const scannedAt = "2026-09-21T04:52:50.000Z"; // 11:52:50 giờ VN
  assert.equal(
    buildProofClipFileName({ waybillCode: "SPXVN123", scannedAt, eventKind: "return" }),
    "HOAN-SPXVN123-20260921-115250.mp4",
  );
  assert.equal(
    buildProofClipFileName({ waybillCode: "SPXVN123", scannedAt, eventKind: "outbound" }),
    "SPXVN123-20260921-115250.mp4",
  );
  assert.equal(buildProofClipFileName({ waybillCode: "SPXVN123", scannedAt }), "SPXVN123-20260921-115250.mp4");
});

test("dải chữ in trên hình: kiện hoàn tự khai loại và kết quả kiểm", () => {
  assert.equal(
    returnStripLabel({ event_kind: "return", return_kind: "rts", inspection_result: "swapped" }),
    "HÀNG HOÀN · Giao thất bại · Tráo",
  );
  assert.equal(
    returnStripLabel({ event_kind: "return", return_kind: "customer_return", inspection_result: null }),
    "HÀNG HOÀN · Khách trả",
  );
  assert.equal(returnStripLabel({ event_kind: "outbound" }), null, "đơn đi không đổi dải chữ");
});

// ---------------------------------------------------------------------------
// Clip khiếu nại không được cắt khi đoạn video cuối còn đang ghi.
// ---------------------------------------------------------------------------

test("clip kiện hoàn chỉ xin cắt sau khi mọi đoạn phủ nó đã ghi xong", () => {
  const ended = "2026-09-21T04:53:37.000Z";
  const at = (s: number) => Date.parse(ended) + s * 1000;
  assert.equal(returnClipSettled(ended, at(10)), false, "vừa đóng kiện: đoạn cuối còn đang ghi");
  assert.equal(returnClipSettled(ended, at(RETURN_CLIP_SETTLE_SECONDS - 1)), false);
  assert.equal(returnClipSettled(ended, at(RETURN_CLIP_SETTLE_SECONDS)), true);
  assert.equal(returnClipSettled(null, at(9999)), false, "kiện chưa đóng thì không cắt");
  assert.ok(RETURN_CLIP_SETTLE_SECONDS >= 120, "phải phủ được post-roll + một segment");
});

// ---------------------------------------------------------------------------
// Mọi loại lệnh code chèn vào agent_commands phải được database cho phép.
// Lỗi thật: `set_return_capture` bị ràng buộc chặn, agent không bao giờ
// nhận được tín hiệu phiên hoàn — mà không một test nào kêu.
// ---------------------------------------------------------------------------

test("mọi loại lệnh agent trong code đều có trong ràng buộc database", () => {
  const sources = [
    "src/lib/agent-commands/enqueue.ts",
    "src/lib/station/return-capture.ts",
  ].map((f) => readFileSync(f, "utf8"));
  const types = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/type:\s*"([a-z_]+)"/g)) types.add(m[1]);
  }
  assert.ok(types.has("set_return_capture"));
  assert.ok(types.has("cut_clip") || types.has("start_recording"));

  const migrations = readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"));
  const constraintSql = migrations.filter((m) => m.includes("agent_commands_type_check")).join("\n");
  for (const t of types) {
    assert.ok(
      constraintSql.includes(`'${t}'`),
      `loại lệnh '${t}' được code chèn nhưng không migration nào cho phép trong agent_commands_type_check`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tải lên chậm: agent gặp "object đã tồn tại" thì báo thẳng upload-complete.
// Cloud là chốt duy nhất xác minh object đó đúng bản agent đang giữ.
// ---------------------------------------------------------------------------

test("upload-complete đối chiếu kích thước object với file agent cắt", () => {
  const src = readFileSync("src/app/api/agent/clip-upload-complete/route.ts", "utf8");
  assert.ok(src.includes("bucket_size_mismatch"));
  assert.ok(
    src.includes(`clip.status === "pending"`),
    "chỉ đối chiếu khi clip chưa promote — bản cắt lại của clip đã ready được phép lệch",
  );
});
