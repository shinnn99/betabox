import { pickScanCode, type CodeCandidate } from "./code-pick";

export interface QrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DecodedQr {
  text: string;
  box: QrBox;
}

export interface QrEmission {
  text: string;
  scannedAt: string;
  bestFrameAt: string;
  box: QrBox;
}

export interface QrZoneResult {
  emission?: QrEmission;
  warning?: "multiple_qr";
}

interface Candidate {
  text: string;
  count: number;
  firstSeenMs: number;
  bestFrameMs: number;
  bestBox: QrBox;
}

function area(box: QrBox): number {
  return box.width * box.height;
}

/** Máy trạng thái một nhãn tại vùng đóng hàng. */
export class QrZone {
  private currentText: string | null = null;
  private currentLastSeenMs = 0;
  private candidate: Candidate | null = null;
  private lastEmitMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly confirmFrames: number,
    private readonly absenceMs: number,
  ) {}

  ingest(decoded: CodeCandidate[], frameAt: Date): QrZoneResult {
    const frameMs = frameAt.getTime();
    // Chọn đúng MỘT mã trong khung — luật chọn ở code-pick.ts.
    const chosen = pickScanCode(decoded);
    const unique = new Map<string, DecodedQr>();
    if (chosen.picked) unique.set(chosen.picked.text, chosen.picked);

    if (chosen.ambiguous) {
      this.candidate = null;
      return { warning: "multiple_qr" };
    }
    if (unique.size === 0) {
      this.candidate = null;
      return {};
    }

    const qr = unique.values().next().value as DecodedQr;
    if (qr.text === this.currentText) {
      this.currentLastSeenMs = frameMs;
      this.candidate = null;
      return {};
    }

    if (!this.candidate || this.candidate.text !== qr.text) {
      this.candidate = {
        text: qr.text,
        count: 1,
        firstSeenMs: frameMs,
        bestFrameMs: frameMs,
        bestBox: qr.box,
      };
    } else {
      this.candidate.count += 1;
      if (area(qr.box) > area(this.candidate.bestBox)) {
        this.candidate.bestBox = qr.box;
        this.candidate.bestFrameMs = frameMs;
      }
    }

    const currentAbsentLongEnough =
      this.currentText === null || frameMs - this.currentLastSeenMs >= this.absenceMs;
    const rateLimitSatisfied = frameMs - this.lastEmitMs >= this.absenceMs;
    if (
      this.candidate.count < this.confirmFrames ||
      !currentAbsentLongEnough ||
      !rateLimitSatisfied
    ) {
      return {};
    }

    const emission: QrEmission = {
      text: this.candidate.text,
      scannedAt: new Date(this.candidate.firstSeenMs).toISOString(),
      bestFrameAt: new Date(this.candidate.bestFrameMs).toISOString(),
      box: this.candidate.bestBox,
    };
    this.currentText = emission.text;
    this.currentLastSeenMs = frameMs;
    this.lastEmitMs = frameMs;
    this.candidate = null;
    return { emission };
  }
}
