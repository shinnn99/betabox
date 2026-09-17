import assert from "node:assert/strict";
import test from "node:test";
import { planStartFailure } from "../src/recording-lifecycle";

// Ca thật 17/09/2026 16:21: EZVIZ rớt wifi đúng lúc mở ca BAN_04. Lệnh
// start_recording do trigger bắn một lần, lần spawn đầu hỏng, agent bỏ cuộc
// → cả ca không có video tới khi có người mở lại ca.

test("first cloud start that fails transiently is retried, not dropped", () => {
  assert.equal(
    planStartFailure({ kind: "transient", isFreshStart: true, isLocalStart: false }),
    "retry",
  );
});

test("retry path (already recording before) keeps retrying", () => {
  assert.equal(
    planStartFailure({ kind: "transient", isFreshStart: false, isLocalStart: false }),
    "retry",
  );
});

test("local QR start is dropped — the cloud command that follows owns the retry", () => {
  assert.equal(
    planStartFailure({ kind: "transient", isFreshStart: false, isLocalStart: true }),
    "drop",
  );
});

test("permanent errors are not decided here", () => {
  assert.throws(() =>
    planStartFailure({ kind: "permanent", isFreshStart: true, isLocalStart: false }),
  );
});
