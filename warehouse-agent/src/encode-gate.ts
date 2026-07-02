/**
 * 3b-2: 1-in-flight encode. Chỉ 1 flag + wrapper `run()`.
 *
 * Bảo vệ recording khỏi encode tranh CPU (Việc 1 đã đo:
 * recording I/O-bound, encode CPU-bound, không tranh, KHÔNG cần
 * below-normal priority). Vẫn cần 1-in-flight để chống 2 encode
 * chồng ca hiếm (2 người tra cùng cửa sổ 3s poll).
 *
 * Cơ chế đóng kín ở cloud:
 *   - Agent poll với `encoding_busy=true` khi gate busy → cloud
 *     exclude cut_clip khỏi claim.
 *   - Agent poll với `encoding_busy=false` khi rảnh → cloud claim
 *     tối đa 1 cut_clip.
 *   - Job cut_clip dư nằm `pending` ở cloud, poll sau lấy.
 *
 * throw gate_busy_race trong `run()` khi đã busy = ASSERTION PHÒNG
 * THỦ fail-loud. Nếu poll-filter + claim-limit-1 làm đúng thì không
 * bao giờ tới đây. Nếu tới, ném lỗi rõ để lộ bug logic, KHÔNG âm
 * thầm chạy encode thứ hai (dẫn tới tranh CPU).
 */
export class EncodeGate {
  private busy = false;

  isBusy(): boolean {
    return this.busy;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) {
      // Assertion phòng thủ. Log to trước khi throw để ops có
      // đường dò.
      console.error(
        "[encode-gate] gate_busy_race: attempted to run() while busy — poll-filter or claim-limit logic broken",
      );
      throw new Error("gate_busy_race");
    }
    this.busy = true;
    try {
      return await task();
    } finally {
      this.busy = false;
    }
  }
}
