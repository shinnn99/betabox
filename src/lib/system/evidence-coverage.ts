/**
 * Toán phủ bằng chứng — lõi dùng chung của BB-2 và BB-3.
 *
 * HAI CÂU HỎI, MỘT PHÉP TÍNH:
 *   * BB-2 "đơn này có mất bằng chứng không": cửa sổ = khoảng đóng đơn,
 *     nguồn = segment của camera bằng chứng phủ khoảng đó.
 *   * BB-3 "kho mù bao nhiêu bàn-phút": cửa sổ = giờ kho của ngày, nguồn =
 *     toàn bộ segment của MỘT camera trong ngày.
 * Cả hai đều là "hợp các khoảng đã ghi, trừ khỏi cửa sổ, đo phần còn lại".
 *
 * VÌ SAO KHÔNG DÙNG LẠI KẾT LUẬN CỦA resolveClipBounds: resolver trả lời
 * "có cắt được clip không", nên MỘT segment chạm mép cửa sổ là đủ `ok`.
 * Một segment phủ 10 giây đầu của đơn 180 giây vẫn qua cửa đó — trong khi
 * với BB-2 đơn ấy đã mất 170 giây bằng chứng. Hai câu hỏi khác nhau, và
 * gộp chúng lại là cách chắc chắn nhất để BB-2 báo xanh trong lúc khách
 * xem clip cụt.
 *
 * ĐO KẾT QUẢ, KHÔNG ĐO NGUYÊN NHÂN. Không hàm nào ở đây đọc heartbeat hay
 * probe. Lý do là yêu cầu union của BB-3: agent chết 10 phút trong lúc
 * camera cũng offline đúng 10 phút đó phải ra 10, không phải 20. Đo lỗ
 * trên trục thời gian có/không có file thì union là hệ quả tự nhiên của
 * phép tính, không phải một bước khử trùng lặp phải nhớ làm đúng.
 *
 * File này THUẦN HÀM: không truy vấn, không `new Date()` ngầm. Mọi mốc
 * thời gian do caller truyền vào — để test dựng được ca biên mà không phải
 * giả lập đồng hồ, và để cùng một đầu vào luôn cho cùng một con số khi
 * chạy lại sổ.
 */

/** Khoảng thời gian nửa mở [start, end), đơn vị ms epoch. */
export interface Interval {
  start: number;
  end: number;
}

export type CoverageVerdict =
  /** Phủ trọn cửa sổ. Bằng chứng còn nguyên. */
  | "covered"
  /** Có phủ nhưng thủng ở đâu đó. Vẫn là mất bằng chứng, mức nhẹ hơn. */
  | "partial"
  /** Không giây nào được phủ, hoặc không có camera. Mức nghiêm trọng. */
  | "missing"
  /**
   * CHƯA KẾT LUẬN ĐƯỢC, và phải tách khỏi ba nhãn kia.
   *
   * Segment cuối còn đang mở (`ended_at IS NULL`) nghĩa là ffmpeg vẫn đang
   * ghi vào đúng file đó — dữ liệu chưa flush xuống đĩa nên chưa đếm được,
   * chứ không phải không có. Chấm "missing" ở đây là vu oan cho mọi đơn
   * vừa đóng xong; chấm "covered" là đoán. Người quét lại sau vài phút.
   */
  | "defer";

export interface CoverageResult {
  verdict: CoverageVerdict;
  /** Độ dài cửa sổ (giây). Mẫu số của mọi tỷ lệ phủ. */
  windowSeconds: number;
  /** Số giây trong cửa sổ có file phủ. */
  coveredSeconds: number;
  /** windowSeconds - coveredSeconds. Đây là lượng bằng chứng đã mất. */
  gapSeconds: number;
  /** Các lỗ cụ thể, để dòng lý do nói được "thủng lúc nào". */
  gaps: Interval[];
}

/**
 * Hợp các khoảng chồng lấn/liền kề thành danh sách rời nhau, đã sắp xếp.
 *
 * Segment kề sát nhau (segment trước kết thúc đúng lúc segment sau bắt
 * đầu) phải nhập làm một: ffmpeg cắt file mỗi 60 giây nên một ca ghi liên
 * tục là hàng trăm khoảng nối đuôi. Không nhập thì mỗi mối nối thành một
 * "lỗ 0 giây" và danh sách lý do dài vô nghĩa.
 */
export function mergeIntervals(list: Interval[]): Interval[] {
  const valid = list
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of valid) {
    const last = out[out.length - 1];
    // `>=` chứ không `>`: chạm mép cũng là liền mạch.
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
      continue;
    }
    out.push({ start: cur.start, end: cur.end });
  }
  return out;
}

/** Phần của `list` nằm trong `window`, đã hợp và cắt gọn hai đầu. */
export function clampToWindow(list: Interval[], window: Interval): Interval[] {
  const clamped: Interval[] = [];
  for (const i of mergeIntervals(list)) {
    const start = Math.max(i.start, window.start);
    const end = Math.min(i.end, window.end);
    if (end > start) clamped.push({ start, end });
  }
  return clamped;
}

/** Các khoảng trong `window` KHÔNG được `list` phủ. */
export function gapsInWindow(list: Interval[], window: Interval): Interval[] {
  if (window.end <= window.start) return [];
  const covered = clampToWindow(list, window);
  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const c of covered) {
    if (c.start > cursor) gaps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

/** Một segment như `camera_recording_files` trả về. */
export interface SegmentLike {
  started_at: string;
  /** null = file còn đang ghi. */
  ended_at: string | null;
}

function toMs(iso: string | null): number {
  if (!iso) return Number.NaN;
  return new Date(iso).getTime();
}

const SECOND = 1_000;

/**
 * Chấm một cửa sổ: phủ trọn, thủng, hay trống.
 *
 * `segments` là mọi file có giao với cửa sổ — caller lọc sẵn theo camera và
 * theo `source='agent'` (dòng do route Next.js cũ ghi trỏ ổ máy khác, không
 * chứng minh được gì về ổ của agent; xem clip-resolver.ts:509-514).
 *
 * Segment còn mở đè lên mọi kết luận khác → "defer". Đặt cửa này TRƯỚC khi
 * cộng phủ có chủ đích: một đơn vừa đóng gần như luôn có segment cuối đang
 * mở, và nếu cộng phủ trước thì nó ra "partial" — tức mỗi đơn bình thường
 * đều bị chấm mất bằng chứng đúng một lần rồi mới được sửa lại ở lượt quét
 * sau. Sổ ghi bằng con số đầu tiên, nên cửa này phải đứng trước.
 */
export function coverageOfWindow(
  segments: SegmentLike[],
  window: Interval,
): CoverageResult {
  const windowSeconds = Math.max(0, Math.round((window.end - window.start) / SECOND));
  const empty: CoverageResult = {
    verdict: "missing",
    windowSeconds,
    coveredSeconds: 0,
    gapSeconds: windowSeconds,
    gaps: windowSeconds > 0 ? [{ start: window.start, end: window.end }] : [],
  };
  if (windowSeconds === 0) return { ...empty, verdict: "defer", gaps: [] };

  const hasOpenInRange = segments.some(
    (s) => s.ended_at === null && toMs(s.started_at) <= window.end,
  );
  if (hasOpenInRange) {
    return { ...empty, verdict: "defer", gaps: [] };
  }

  const intervals: Interval[] = [];
  for (const s of segments) {
    const start = toMs(s.started_at);
    const end = toMs(s.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    intervals.push({ start, end });
  }

  const covered = clampToWindow(intervals, window);
  const coveredMs = covered.reduce((n, i) => n + (i.end - i.start), 0);
  const coveredSeconds = Math.round(coveredMs / SECOND);
  const gaps = gapsInWindow(intervals, window);
  const gapSeconds = Math.max(0, windowSeconds - coveredSeconds);

  if (coveredSeconds === 0) return empty;
  return {
    verdict: gapSeconds === 0 ? "covered" : "partial",
    windowSeconds,
    coveredSeconds,
    gapSeconds,
    gaps,
  };
}

// ============================================================================
// BB-3: bàn-phút mất khả năng ghi trong giờ kho
// ============================================================================

/**
 * Giờ kho của MỘT ngày-kho, suy từ hoạt động thật.
 *
 * Không đọc khung giờ khai báo — `warehouses.operating_hours` đã bị bỏ
 * ngày 13/08/2026 vì không kho nào chịu khai và mọi kho mới sẽ quên, biến
 * cảnh báo thành thứ tắt/bật theo trí nhớ người dựng hệ.
 *
 * Mốc đầu/cuối là scan đơn đầu tiên và cuối cùng trong ngày. Hệ quả đã
 * biết và đã chấp nhận: camera chết TRƯỚC đơn đầu tiên hoặc SAU đơn cuối
 * cùng không sinh bàn-phút nào. Đúng — lúc đó không có đơn nào để mất bằng
 * chứng, và tính vào thì mỗi đêm kho nghỉ lại đẻ ra hàng trăm phút.
 *
 * Trả null khi ngày đó có 0 hoặc 1 scan: một mốc không tạo thành khoảng.
 */
export function warehouseHoursFromScans(scanTimes: string[]): Interval | null {
  const ms = scanTimes.map(toMs).filter((n) => Number.isFinite(n));
  if (ms.length < 2) return null;
  const start = Math.min(...ms);
  const end = Math.max(...ms);
  return end > start ? { start, end } : null;
}

export interface CameraGapResult {
  cameraId: string;
  /** Bàn-phút mất khả năng ghi của riêng camera này trong giờ kho. */
  lostMinutes: number;
  gaps: Interval[];
}

/**
 * Bàn-phút mất khả năng ghi của một camera trong giờ kho.
 *
 * CHỈ GỌI CHO CAMERA ĐÃ TỪNG GHI TRONG NGÀY ĐÓ. Camera không nằm trong
 * diện ghi hình (chưa bật, đang bảo trì, mới khai) sẽ có 0 segment và hàm
 * này sẽ trả về đúng bằng độ dài giờ kho — con số vô nghĩa đó cộng lên kho
 * sẽ làm mọi kho đỏ vĩnh viễn và BB-3 mất hết giá trị. Cửa lọc "có ≥1
 * segment trong ngày" nằm ở caller vì nó là câu truy vấn, không phải phép
 * tính; caller phải áp, và đây là chỗ ghi lại giao kèo đó.
 *
 * Không có tham số ngưỡng: mọi giây thiếu file đều tính. Lỗ nhỏ do ffmpeg
 * xoay file (dưới một giây) tự biến mất ở mergeIntervals vì segment kề sát
 * được nhập làm một.
 */
export function cameraGapMinutes(
  cameraId: string,
  segments: SegmentLike[],
  hours: Interval,
): CameraGapResult {
  const intervals: Interval[] = [];
  for (const s of segments) {
    const start = toMs(s.started_at);
    // Segment còn mở trong giờ kho = đang ghi tới hết cửa sổ. Khác hẳn ca
    // BB-2: ở đây không cần đợi flush vì ta chỉ hỏi "có đang ghi không",
    // không cắt gì từ nó.
    const end = s.ended_at === null ? hours.end : toMs(s.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    intervals.push({ start, end });
  }
  const gaps = gapsInWindow(intervals, hours);
  const lostMs = gaps.reduce((n, g) => n + (g.end - g.start), 0);
  return { cameraId, lostMinutes: Math.round(lostMs / 60_000), gaps };
}
