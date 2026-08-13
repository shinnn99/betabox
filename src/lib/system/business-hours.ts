/**
 * Giờ vận hành kho — dùng cho các mục kiểm hạ tầng có tính "chỉ đúng
 * trong giờ làm".
 *
 * VÌ SAO CẦN FILE NÀY (bằng chứng, không phải phỏng đoán):
 *   Kho Đại Kim tắt máy sau ca. 15 ngày vận hành đo được từ
 *   `camera_recording_files` (24/07→12/08/2026): segment đầu tiên trong
 *   ngày rơi vào 08:21–10:31, segment cuối 16:22–18:31, và cả 3 Chủ nhật
 *   (26/07, 02/08, 09/08) đều 0 segment. Nghĩa là mỗi đêm có ~14 giờ agent
 *   im HOÀN TOÀN BÌNH THƯỜNG. Ngưỡng cũ (crit khi im > 120 phút, đo bằng
 *   tuổi thô của last_seen_at) sẽ bắn tin Lark "Kho này đang KHÔNG ghi
 *   hình — gọi kiểm máy ngay" mỗi tối, 365 đêm/năm.
 *
 * HAI CÁCH LÀM, VÀ VÌ SAO CHỌN CÁCH THỨ HAI:
 *   (a) "Ngoài giờ thì bỏ qua, trong giờ thì đo tuổi thô." — VẪN SAI. Lúc
 *       09:00 sáng thứ Hai, tuổi thô của last_seen_at là ~15 giờ (từ chiều
 *       thứ Bảy) → crit ngay phút đầu mở cửa, mỗi ngày.
 *   (b) Đo phần im lặng NẰM TRONG giờ vận hành (`operatingMsBetween`).
 *       09:00 thứ Hai, kho mở 09:00 → im-trong-giờ = 0 phút → xanh. 11:00
 *       mà vẫn chưa có heartbeat → im-trong-giờ = 120 phút → crit thật.
 *       Cùng một công thức lo cả hai đầu, không cần hằng số "ân hạn buổi
 *       sáng" nào thêm.
 *
 * File này THUẦN: không DB, không env, không `now` ngầm. Mọi thứ vào qua
 * tham số để test được bằng ngày giờ cố định.
 */

/** 1 = Thứ Hai … 7 = Chủ nhật (ISO-8601). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface OperatingHours {
  /** Tên vùng IANA, ví dụ "Asia/Bangkok". Đã kiểm hợp lệ lúc parse. */
  timezone: string;
  /** Phút tính từ 00:00 giờ địa phương. */
  startMinute: number;
  endMinute: number;
  /** Ngày trong tuần có vận hành. Luôn đã sắp xếp, không trùng. */
  days: IsoWeekday[];
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Trần thời gian nhìn ngược. Im lặng dài hơn ngần này thì đã vượt mọi
 * ngưỡng crit từ lâu — đếm chính xác thêm không đổi kết luận, mà vòng lặp
 * theo ngày thì không được phép chạy vô hạn trong route chạy nền.
 */
const MAX_LOOKBACK_DAYS = 40;

// ── Múi giờ ───────────────────────────────────────────────────────────
// Asia/Bangkok không có DST, nhưng module này không được viết theo giả
// định đó: khách sau có thể ở vùng có DST, và một hàm "đúng vì may mắn"
// là loại nợ khó tìm nhất. Dùng Intl để đổi qua lại, không tự cộng offset.

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached) return cached;
  // Ném RangeError nếu tên vùng sai — parseOperatingHours bắt để trả null.
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATTERS.set(timezone, f);
  return f;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(ts: number, timezone: string): ZonedParts {
  const parts = formatter(timezone).formatToParts(new Date(ts));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  // hour12:false vẫn có thể trả "24" cho nửa đêm ở một số môi trường ICU.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Chênh lệch (giờ địa phương − UTC) tại đúng thời điểm `ts`, tính bằng ms. */
function zoneOffsetMs(ts: number, timezone: string): number {
  const z = zonedParts(ts, timezone);
  const asIfUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asIfUtc - ts;
}

/**
 * Đổi một mốc giờ-treo-tường ở `timezone` thành mốc UTC.
 *
 * Hai vòng vì offset phụ thuộc chính thời điểm đang tìm (bài toán con gà
 * quả trứng ở ranh giới DST): đoán bằng offset tại thời điểm ước lượng,
 * rồi soi lại offset tại kết quả và sửa nếu khác.
 */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string,
): number {
  const guess = Date.UTC(year, month - 1, day) + minuteOfDay * MINUTE_MS;
  const first = guess - zoneOffsetMs(guess, timezone);
  const second = guess - zoneOffsetMs(first, timezone);
  return second;
}

function isoWeekday(z: ZonedParts): IsoWeekday {
  const dow = new Date(Date.UTC(z.year, z.month - 1, z.day)).getUTCDay();
  return (dow === 0 ? 7 : dow) as IsoWeekday;
}

// ── Đọc cấu hình ──────────────────────────────────────────────────────

function parseHhMm(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function parseDays(raw: unknown): IsoWeekday[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = new Set<IsoWeekday>();
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 7) return null;
    out.add(v as IsoWeekday);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Đọc cột `warehouses.operating_hours`.
 *
 * Trả `null` khi CHƯA cấu hình hoặc cấu hình sai — và hai ca đó caller
 * phải xử lý GIỐNG NHAU: theo dõi 24/7. Cố ý chọn hướng ồn hơn thay vì im
 * hơn: một kho cấu hình lỗi mà bị im cảnh báo là đúng cái lỗ hổng module
 * này sinh ra để bịt. Caller phân biệt được hai ca qua `operatingHoursError`.
 *
 * KHÔNG hỗ trợ ca đêm (end ≤ start). Không kho nào của Betacom chạy qua
 * nửa đêm; chấp nhận sai còn hơn đoán, nên ca đó bị coi là cấu hình sai.
 */
export function parseOperatingHours(raw: unknown): OperatingHours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const timezone = typeof r.timezone === "string" ? r.timezone.trim() : "";
  if (!timezone) return null;
  try {
    formatter(timezone);
  } catch {
    return null;
  }

  const startMinute = parseHhMm(r.start);
  const endMinute = parseHhMm(r.end);
  if (startMinute === null || endMinute === null) return null;
  if (endMinute <= startMinute) return null;

  const days = parseDays(r.days);
  if (!days) return null;

  return { timezone, startMinute, endMinute, days };
}

// ── Hỏi đáp về giờ ────────────────────────────────────────────────────

export function isWithinOperatingHours(at: Date, hours: OperatingHours): boolean {
  const z = zonedParts(at.getTime(), hours.timezone);
  if (!hours.days.includes(isoWeekday(z))) return false;
  const minuteOfDay = z.hour * 60 + z.minute;
  return minuteOfDay >= hours.startMinute && minuteOfDay < hours.endMinute;
}

/**
 * Số ms của khoảng [from, to] NẰM TRONG giờ vận hành.
 *
 * Đây là hàm trung tâm của cả thiết kế: "agent im bao lâu" phải hiểu là
 * "im bao lâu trong lúc đáng ra phải chạy", không phải "cách lần cuối
 * thấy mặt bao lâu".
 */
export function operatingMsBetween(from: Date, to: Date, hours: OperatingHours): number {
  const toTs = to.getTime();
  let fromTs = from.getTime();
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) return 0;
  // Lệch đồng hồ máy kho có thể đẩy last_seen_at về tương lai. Âm thì coi
  // như 0, không để nó biến thành số dương kỳ dị ở chỗ khác.
  if (toTs <= fromTs) return 0;
  const floor = toTs - MAX_LOOKBACK_DAYS * DAY_MS;
  if (fromTs < floor) fromTs = floor;

  let total = 0;
  const counted = new Set<string>();
  // Bước nửa ngày + khử trùng theo ngày-địa-phương: bước 24h có thể nhảy
  // cóc qua một ngày khi vùng có DST, bước 12h thì không.
  const step = DAY_MS / 2;
  for (let cursor = fromTs - DAY_MS; cursor <= toTs + DAY_MS; cursor += step) {
    const z = zonedParts(cursor, hours.timezone);
    const dayKey = `${z.year}-${z.month}-${z.day}`;
    if (counted.has(dayKey)) continue;
    counted.add(dayKey);
    if (!hours.days.includes(isoWeekday(z))) continue;

    const winStart = wallClockToUtc(z.year, z.month, z.day, hours.startMinute, hours.timezone);
    const winEnd = wallClockToUtc(z.year, z.month, z.day, hours.endMinute, hours.timezone);
    const lo = Math.max(winStart, fromTs);
    const hi = Math.min(winEnd, toTs);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

const DAY_LABEL: Record<IsoWeekday, string> = {
  1: "T2",
  2: "T3",
  3: "T4",
  4: "T5",
  5: "T6",
  6: "T7",
  7: "CN",
};

function hhmm(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "T2–T7 09:30–16:00 (Asia/Bangkok)" — để nhét thẳng vào tin cảnh báo. */
export function describeOperatingHours(hours: OperatingHours): string {
  const runs: string[] = [];
  let i = 0;
  while (i < hours.days.length) {
    let j = i;
    while (j + 1 < hours.days.length && hours.days[j + 1] === hours.days[j] + 1) j++;
    runs.push(
      j - i >= 2
        ? `${DAY_LABEL[hours.days[i]]}–${DAY_LABEL[hours.days[j]]}`
        : hours.days.slice(i, j + 1).map((d) => DAY_LABEL[d]).join(", "),
    );
    i = j + 1;
  }
  return `${runs.join(", ")} ${hhmm(hours.startMinute)}–${hhmm(hours.endMinute)} (${hours.timezone})`;
}

/**
 * Gộp giờ của nhiều kho trong CÙNG một tổ chức thành một khung.
 *
 * Vì sao phải gộp: `warehouse_agents` chỉ có `organization_id`, KHÔNG có
 * `warehouse_id` (đã kiểm schema 13/08/2026). Nên khi một org có nhiều
 * kho, không cách nào biết agent thuộc kho nào — phải lấy khung bao ngoài.
 *
 * Luật gộp, chọn theo hướng "thà theo dõi thừa còn hơn thiếu":
 *   * Bất kỳ kho nào CHƯA cấu hình giờ → cả org về 24/7 (trả null). Kho
 *     chưa cấu hình mà bị im cảnh báo là ca tệ nhất.
 *   * Khác múi giờ → không gộp được → 24/7.
 *   * Còn lại: lấy start sớm nhất, end muộn nhất, hợp các ngày.
 *
 * Hết nợ này khi `warehouse_agents` có `warehouse_id`; lúc đó map thẳng
 * agent → kho và bỏ hàm gộp.
 */
export function mergeOperatingHours(
  list: Array<OperatingHours | null>,
): OperatingHours | null {
  if (list.length === 0) return null;
  if (list.some((h) => h === null)) return null;
  const hours = list as OperatingHours[];
  const tz = hours[0].timezone;
  if (hours.some((h) => h.timezone !== tz)) return null;

  const days = new Set<IsoWeekday>();
  let startMinute = Number.POSITIVE_INFINITY;
  let endMinute = Number.NEGATIVE_INFINITY;
  for (const h of hours) {
    for (const d of h.days) days.add(d);
    startMinute = Math.min(startMinute, h.startMinute);
    endMinute = Math.max(endMinute, h.endMinute);
  }
  return {
    timezone: tz,
    startMinute,
    endMinute,
    days: [...days].sort((a, b) => a - b),
  };
}
