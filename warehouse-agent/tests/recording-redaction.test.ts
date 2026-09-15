import assert from "node:assert/strict";
import test from "node:test";
import { maskRtspUrl } from "../src/recording";

test("recording logs remove complete camera userinfo", () => {
  const url = new URL("rtsp://192.0.2.10/live");
  url.username = "operator";
  url.password = "sensitive-value";
  const input = `Input #0: ${url.toString()}`;
  const output = maskRtspUrl(input);

  assert.equal(output, "Input #0: rtsp://***@192.0.2.10/live");
  assert.doesNotMatch(output, /operator|sensitive-value/);
});
