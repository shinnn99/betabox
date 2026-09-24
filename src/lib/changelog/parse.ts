/**
 * Đọc phần "Phát hành cho người dùng" trong các file `changelog/*.md`.
 *
 * Chủ dự án chốt 24/09/2026: cập nhật gì thì ghi vào thư mục `changelog/`,
 * giao diện tự đọc ra. Nhưng phần còn lại của các file đó viết cho người
 * làm phần mềm (tên file, tên hàm, mã migration) — đổ thẳng ra cho người
 * vận hành kho thì họ không hiểu. Nên mỗi file có MỘT mục riêng viết bằng
 * chữ của người dùng, và chỉ mục đó được đọc ra giao diện.
 *
 * Khuôn (xem `changelog/README.md`):
 *
 *   ## Phát hành cho người dùng
 *
 *   <!-- ban: agent=0.12.0 -->
 *   ### Đọc được mã QR nhỏ và cả mã vạch
 *   Một đoạn tóm tắt: việc gì đổi và vì sao.
 *
 *   #### [Sửa lỗi] Mã QR nhỏ trên nhãn TikTok giờ đọc được
 *   Một đoạn chi tiết.
 *
 * `agent=` bỏ trống hoặc ghi `web` nghĩa là chỉ đổi phần trên web.
 * `muc=lon|nho` chỉ cần khi muốn đè mức độ suy ra từ số phiên bản.
 */

import type { ChangeItem, ChangeTag, Release, ReleaseScale } from "./types";

const SECTION_HEADING = "## Phát hành cho người dùng";
const TAGS: ChangeTag[] = ["Mới", "Sửa lỗi", "Cải tiến"];

interface Marker {
  agentVersion: string | null;
  scale: ReleaseScale | undefined;
}

function parseMarker(line: string): Marker | null {
  const m = /^<!--\s*ban:(.*?)-->$/.exec(line.trim());
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const pair of m[1].trim().split(/\s+/)) {
    const [k, v] = pair.split("=");
    if (k && v) fields.set(k.trim(), v.trim());
  }
  const agent = fields.get("agent");
  const muc = fields.get("muc");
  return {
    agentVersion: !agent || agent === "web" ? null : agent,
    scale: muc === "lon" || muc === "nho" ? muc : undefined,
  };
}

function parseItemHeading(line: string): { tag: ChangeTag; title: string } | null {
  const m = /^####\s*\[([^\]]+)\]\s*(.+)$/.exec(line.trim());
  if (!m) return null;
  const tag = m[1].trim() as ChangeTag;
  if (!TAGS.includes(tag)) {
    throw new Error(
      `Nhãn "${tag}" không hợp lệ ở dòng "${line.trim()}". Chỉ dùng: ${TAGS.join(", ")}.`,
    );
  }
  return { tag, title: m[2].trim() };
}

/** Ngày lấy từ tên file `changelog/2026-09-24.md`. */
export function dateFromFilename(filename: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})\.md$/.exec(filename.replace(/\\/g, "/"));
  return m ? m[1] : null;
}

/**
 * Trả về các bản phát hành khai trong MỘT file. File không có mục "Phát
 * hành cho người dùng" thì trả mảng rỗng — phần lớn file là nhật ký kỹ
 * thuật, không phải bản phát hành.
 */
export function parseReleaseSection(markdown: string, date: string): Release[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === SECTION_HEADING);
  if (start === -1) return [];

  const releases: Release[] = [];
  let marker: Marker | null = null;
  let current: Release | null = null;
  let item: ChangeItem | null = null;
  /** Đang gom đoạn văn cho tóm tắt (null) hay cho một mục con. */
  let buffer: string[] = [];

  const flushText = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    buffer = [];
    if (!text) return;
    if (item) item.detail = item.detail ? `${item.detail} ${text}` : text;
    else if (current) current.summary = current.summary ? `${current.summary} ${text}` : text;
  };
  const closeItem = () => {
    flushText();
    if (current && item) current.items.push(item);
    item = null;
  };
  const closeRelease = () => {
    closeItem();
    if (current) releases.push(current);
    current = null;
  };

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // Hết mục: gặp tiêu đề cấp 2 khác, hoặc đường kẻ ngang.
    if (/^##\s/.test(trimmed) || trimmed === "---") break;

    const found = parseMarker(trimmed);
    if (found) {
      marker = found;
      continue;
    }

    if (/^###\s/.test(trimmed)) {
      closeRelease();
      current = {
        agentVersion: marker?.agentVersion ?? null,
        date,
        title: trimmed.replace(/^###\s*/, "").trim(),
        summary: "",
        items: [],
      };
      // Chỉ gắn khi thật sự có: `scale: undefined` và "không có khoá scale"
      // là hai thứ khác nhau khi đem so với file sinh ra (JSON bỏ undefined).
      if (marker?.scale) current.scale = marker.scale;
      marker = null;
      continue;
    }

    const heading = parseItemHeading(trimmed);
    if (heading) {
      if (!current) {
        throw new Error(`Mục con "${heading.title}" nằm ngoài một bản phát hành (thiếu "### ").`);
      }
      closeItem();
      item = { tag: heading.tag, title: heading.title, detail: "" };
      continue;
    }

    if (trimmed === "") {
      flushText();
      continue;
    }
    if (current) buffer.push(trimmed);
  }
  closeRelease();

  for (const r of releases) {
    if (!r.summary) throw new Error(`Bản phát hành "${r.title}" thiếu đoạn tóm tắt.`);
    if (r.items.length === 0) throw new Error(`Bản phát hành "${r.title}" chưa có mục con nào.`);
    for (const it of r.items) {
      if (!it.detail) throw new Error(`Mục "${it.title}" thiếu đoạn chi tiết.`);
    }
  }
  return releases;
}

/** Gom nhiều file thành một danh sách, mới nhất ở trên. */
export function collectReleases(files: Array<{ name: string; content: string }>): Release[] {
  const out: Release[] = [];
  for (const file of files) {
    const date = dateFromFilename(file.name);
    if (!date) continue;
    out.push(...parseReleaseSection(file.content, date));
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
