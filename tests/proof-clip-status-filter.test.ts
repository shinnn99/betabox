import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const OUTBOUND_PAGE = "src/app/dashboard/videos/page.tsx";
const RETURN_PAGE = "src/app/dashboard/(return-module)/return-videos/page.tsx";
const FILTER_COMPONENT = "src/components/order-proof/ClipStatusFilterSelect.tsx";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("both proof pages expose the same clip-status filter", () => {
  for (const path of [OUTBOUND_PAGE, RETURN_PAGE]) {
    const source = read(path);
    assert.ok(source.includes("<ClipStatusFilterSelect"), path);
    assert.ok(source.includes('useState<ClipStatusFilter>("any")'), path);
    assert.ok(source.includes('params.set("clip_status", clipStatus)'), path);
    assert.ok(source.includes("[waybillSearch, from, to, clipStatus]"), path);
    assert.ok(source.includes("data.next_offset"), `${path} must use the raw pagination cursor`);
  }
});

test("clip-status filter has all user-facing states", () => {
  const source = read(FILTER_COMPONENT);
  for (const value of ["any", "available", "missing", "pending", "failed"]) {
    assert.ok(source.includes(`value: "${value}"`), `missing option ${value}`);
  }
  for (const label of [
    "Tất cả trạng thái",
    "Có clip",
    "Chưa có clip",
    "Đang tạo clip",
    "Clip lỗi",
  ]) {
    assert.ok(source.includes(label), `missing label ${label}`);
  }
});

test("both proof APIs accept availability filters and return listing keeps its flow locked", () => {
  for (const path of [
    "src/app/api/order-proof/scans/route.ts",
    "src/app/api/returns/proof/scans/route.ts",
  ]) {
    const source = read(path);
    assert.ok(source.includes('v === "available"') || source.includes('value === "available"'), path);
    assert.ok(source.includes('v === "missing"') || source.includes('value === "missing"'), path);
  }
  assert.ok(read("src/app/api/returns/proof/scans/route.ts").includes('eventKind: "return"'));
});

test("server filter scans the full matching dataset before paginating", () => {
  const source = read("src/lib/order-proof/service.ts");
  assert.ok(source.includes('clipStatus === "available"'));
  assert.ok(source.includes("clipBucketValid(scan.clip)"));
  assert.ok(source.includes('clipStatus === "missing"'));
  assert.ok(source.includes('scan.clip.status === "evicted"'));
  assert.ok(source.includes("const CLIP_FILTER_SCAN_BATCH = 200"));
  assert.ok(source.includes("while (true)"));
  assert.ok(source.includes("fetchEvents(cursor, CLIP_FILTER_SCAN_BATCH)"));
  assert.ok(source.includes("pageEvents.length === limit"));
  assert.ok(source.includes("next_offset: cursor + index"));
  assert.ok(!source.includes("const scanWindow = filteringByClip"));
});
