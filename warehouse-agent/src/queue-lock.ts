/**
 * Khoá tuần tự cho hàng đợi JSONL (bản 0.13.0).
 *
 * LỖI ĐÃ CÓ THẬT tới 0.12.x (tìm ra 26/09/2026): vòng gửi lại cứ 5 giây đọc
 * BẢN CHỤP hàng đợi, gửi từng dòng (mạng nghẽn thì mỗi dòng tới 2 phút), rồi
 * GHI ĐÈ cả file bằng phần gửi chưa được. Dòng nào được thêm vào TRONG LÚC đó
 * bị ghi đè mất — lượt quét mất trắng, báo đóng đoạn video mất thì đoạn "mở"
 * mãi tới job dọn 03:30 và clip của đơn đó không cắt được. Hai vòng gửi lại
 * còn chạy chồng nhau vì setInterval không chờ vòng trước.
 *
 * Cách sửa: mọi thao tác đổi file (thêm, bớt) đi qua MỘT khoá; bớt thì đọc lại
 * file MỚI NHẤT rồi chỉ bỏ đúng dòng đã gửi được — không bao giờ ghi đè bằng
 * bản chụp cũ.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Lỗi của một lượt không được làm gãy chuỗi cho lượt sau.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Mã HTTP cho biết dòng này hỏng vĩnh viễn — gửi lại bao nhiêu lần cũng thế. */
export function isPermanentRejection(status: number): boolean {
  return status === 400 || status === 413 || status === 422;
}
