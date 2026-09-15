import { resolve } from "node:path";
import { composeProofClip } from "../warehouse-agent/src/compose/clip-composer";

const root = resolve(import.meta.dirname, "..");
const recordingRoot = resolve(root, ".tmp", "qa-recordings");
const day = ["2026", "09", "15"];
const segment = (camera: string, stamp: string) =>
  resolve(recordingRoot, camera, ...day, `${camera}_${stamp}.mp4`);

const outputPath = resolve(
  recordingRoot,
  "_clips",
  "7c6397de-fa86-4fb9-9cd5-d61ea252acc7.pip-qa.mp4",
);

async function main() {
await composeProofClip({
  ffmpegBin: resolve(root, "BetacomAgent", "ffmpeg.exe"),
  overview: {
    firstStartedAt: "2026-09-15T04:24:10.000Z",
    segments: ["20260915_112410", "20260915_112510", "20260915_112610"].map(
      (stamp) => segment("hik_3", stamp),
    ),
  },
  qr: {
    firstStartedAt: "2026-09-15T04:24:10.000Z",
    segments: ["20260915_112410", "20260915_112510", "20260915_112610"].map(
      (stamp) => segment("dahua_3", stamp),
    ),
  },
  outputPath,
  targetStart: "2026-09-15T04:24:20.867Z",
  targetEnd: "2026-09-15T04:26:33.621Z",
  informationText:
    "SPXVN063348086638  ·  Kho Đại Kim  ·  BAN_03  ·  NV002 · Trần Văn B  ·  11:24:30 15/09/2026",
  fontPath: resolve(root, "warehouse-agent", "assets", "fonts", "NotoSans-Bold.ttf"),
});

console.log(outputPath);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
