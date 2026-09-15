import { test } from "node:test";
import assert from "node:assert/strict";
import { maskRtspUrl } from "../src/lib/camera/rtsp.ts";

test("maskRtspUrl removes complete camera userinfo from URLs and FFmpeg text", () => {
  const url = new URL("rtsp://192.0.2.10/live");
  url.username = "operator";
  url.password = "sensitive-value";
  const input = `Cannot open ${url.toString()}`;
  const output = maskRtspUrl(input);

  assert.equal(output, "Cannot open rtsp://***@192.0.2.10/live");
  assert.doesNotMatch(output, /operator|sensitive-value/);
});

test("maskRtspUrl redacts every RTSP and RTSPS URL in one message", () => {
  const first = new URL("rtsp://192.0.2.1/main");
  first.username = "first";
  first.password = "one";
  const second = new URL("rtsps://192.0.2.2/sub");
  second.username = "second";
  second.password = "two";
  const input = [first.toString(), second.toString()].join(" ");

  assert.equal(
    maskRtspUrl(input),
    "rtsp://***@192.0.2.1/main rtsps://***@192.0.2.2/sub",
  );
});
