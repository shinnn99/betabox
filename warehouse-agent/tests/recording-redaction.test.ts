import assert from "node:assert/strict";
import test from "node:test";
import { maskRtspUrl, stripNoisyFfmpegLines } from "../src/recording";

test("recording logs remove complete camera userinfo", () => {
  const url = new URL("rtsp://192.0.2.10/live");
  url.username = "operator";
  url.password = "sensitive-value";
  const input = `Input #0: ${url.toString()}`;
  const output = maskRtspUrl(input);

  assert.equal(output, "Input #0: rtsp://***@192.0.2.10/live");
  assert.doesNotMatch(output, /operator|sensitive-value/);
});

test("QR frame source ignores the harmless deprecated swscaler pixel warning", () => {
  const warning = "[swscaler @ 000001] deprecated pixel format used, make sure you did set range correctly";
  assert.equal(stripNoisyFfmpegLines(warning), "");
  assert.equal(
    stripNoisyFfmpegLines(`${warning}\n[h264] corrupt decoded frame`),
    "[h264] corrupt decoded frame",
  );
});
