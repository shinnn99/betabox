import assert from "node:assert/strict";
import test from "node:test";
import { QrZone, type DecodedQr } from "../src/qr/qr-zone";

const box = { x: 10, y: 20, width: 100, height: 80 };
const qr = (text: string, width = 100): DecodedQr => ({
  text,
  box: { ...box, width },
});
const at = (ms: number) => new Date(1_700_000_000_000 + ms);

test("same label hidden repeatedly during three minutes emits once", () => {
  const zone = new QrZone(2, 2_000);
  assert.equal(zone.ingest([qr("X")], at(0)).emission, undefined);
  assert.equal(zone.ingest([qr("X")], at(100)).emission?.text, "X");
  for (const ms of [5_000, 30_000, 90_000, 180_000]) {
    zone.ingest([], at(ms));
    zone.ingest([qr("X")], at(ms + 2_500));
    assert.equal(zone.ingest([qr("X")], at(ms + 2_600)).emission, undefined);
  }
});

test("new stable label emits once after previous label is absent", () => {
  const zone = new QrZone(2, 2_000);
  zone.ingest([qr("X")], at(0));
  zone.ingest([qr("X")], at(100));
  assert.equal(zone.ingest([qr("Y")], at(2_200)).emission, undefined);
  const result = zone.ingest([qr("Y", 140)], at(2_300));
  assert.equal(result.emission?.text, "Y");
  assert.equal(result.emission?.scannedAt, at(2_200).toISOString());
  assert.equal(result.emission?.bestFrameAt, at(2_300).toISOString());
  assert.equal(result.emission?.box.width, 140);
  assert.equal(zone.ingest([qr("Y")], at(2_400)).emission, undefined);
});

test("label absent only 1.5 seconds does not allow a different label", () => {
  const zone = new QrZone(2, 2_000);
  zone.ingest([qr("X")], at(0));
  zone.ingest([qr("X")], at(100));
  zone.ingest([qr("Y")], at(1_500));
  assert.equal(zone.ingest([qr("Y")], at(1_600)).emission, undefined);
});

test("frame containing two different QR codes is discarded", () => {
  const zone = new QrZone(2, 2_000);
  const result = zone.ingest([qr("X"), qr("Y")], at(0));
  assert.equal(result.warning, "multiple_qr");
  assert.equal(result.emission, undefined);
});
