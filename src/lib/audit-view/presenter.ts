/**
 * Dịch một dòng `audit_logs` thành câu tiếng Việt người vận hành kho đọc hiểu.
 *
 * Vì sao cần: trang Nhật ký hệ thống trước đây đổ thẳng `action` gốc, UUID cắt
 * 8 ký tự và `JSON.stringify(metadata)` ra màn hình. Người đọc trang này là
 * chủ kho / trưởng kho — không phải người làm phần mềm — nên không tra được
 * `camera.delete` + `3f2a1b9c…` là xoá camera nào.
 *
 * Nguyên tắc:
 *   1. KHÔNG bao giờ vỡ UI. Action lạ (thêm sau, chưa kịp khai ở đây) vẫn ra
 *      một câu đọc được, không ra chuỗi rỗng.
 *   2. Mã kỹ thuật (`action`, UUID, JSON) không biến mất — dồn vào phần "chi
 *      tiết kỹ thuật" để khi cần điều tra vẫn có, chỉ là không đập vào mặt.
 *   3. File này thuần, không import React/server — để test chạy trực tiếp.
 */

/** Mức độ quan trọng, quyết định màu và bộ lọc "chỉ việc quan trọng". */
export type AuditSeverity = "critical" | "warning" | "info";

/** Nhóm để lọc theo mảng việc, tránh bắt người dùng nhớ tên mã action. */
export type AuditGroup =
  | "camera"
  | "nguoi-dung"
  | "nhan-su"
  | "kho"
  | "thiet-bi"
  | "tai-khoan"
  | "khac";

export interface AuditRowInput {
  id: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  /**
   * Tên đối tượng đã tra ở server (camera nào, ai, kho nào). Null khi đối
   * tượng đã bị xoá hẳn và metadata cũng không giữ tên.
   */
  target_name?: string | null;
}

export interface AuditChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

export interface PresentedAudit {
  id: string;
  /** Câu chính: "Xoá camera". Luôn có, kể cả action lạ. */
  title: string;
  /** Câu đầy đủ: "Nguyễn A đã xoá camera Cổng sau". Dùng cho dòng danh sách. */
  sentence: string;
  actorLabel: string;
  targetLabel: string | null;
  severity: AuditSeverity;
  group: AuditGroup;
  /** Diễn giải thêm, VD "Đổi mật khẩu kèm theo". Rỗng thì không hiện. */
  notes: string[];
  /** Bảng đổi-từ-gì-sang-gì, đã dịch tên trường. */
  changes: AuditChange[];
  createdAt: string;
  action: string;
}

interface ActionSpec {
  /** Động từ + tân ngữ, VD "Xoá camera". */
  label: string;
  severity: AuditSeverity;
  group: AuditGroup;
  /** Câu mẫu khi có tên đối tượng; `{target}` được thay. */
  withTarget?: string;
}

/**
 * Toàn bộ action đang được ghi ở phía tổ chức (quét từ mọi lời gọi `audit()`
 * ngày 25/09/2026). Thêm action mới ở route thì thêm một dòng ở đây —
 * `tests/audit-presenter.test.ts` canh để không quên.
 */
const ACTIONS: Record<string, ActionSpec> = {
  // --- Camera ---
  "camera.create": {
    label: "Thêm camera",
    withTarget: "đã thêm camera {target}",
    severity: "warning",
    group: "camera",
  },
  "camera.update": {
    label: "Sửa camera",
    withTarget: "đã sửa camera {target}",
    severity: "warning",
    group: "camera",
  },
  "camera.delete": {
    label: "Xoá camera",
    withTarget: "đã xoá camera {target}",
    severity: "critical",
    group: "camera",
  },
  "camera.station.move": {
    label: "Chuyển camera sang bàn khác",
    withTarget: "đã chuyển camera {target} sang bàn khác",
    severity: "warning",
    group: "camera",
  },
  "camera.station.connect.enqueued": {
    label: "Nối camera vào bàn đóng gói",
    withTarget: "đã nối camera {target} vào bàn đóng gói",
    severity: "info",
    group: "camera",
  },
  "camera.recording.start.enqueued": {
    label: "Bật ghi hình",
    withTarget: "đã bật ghi hình camera {target}",
    severity: "info",
    group: "camera",
  },
  "camera.recording.stop.enqueued": {
    label: "Tắt ghi hình",
    withTarget: "đã tắt ghi hình camera {target}",
    severity: "warning",
    group: "camera",
  },
  "camera.test_connection.enqueued": {
    label: "Kiểm tra kết nối camera",
    withTarget: "đã kiểm tra kết nối camera {target}",
    severity: "info",
    group: "camera",
  },
  "camera.probe_codec.enqueued": {
    label: "Kiểm tra định dạng hình",
    withTarget: "đã kiểm tra định dạng hình của camera {target}",
    severity: "info",
    group: "camera",
  },
  "camera.test_draft": {
    label: "Thử kết nối camera trước khi lưu",
    severity: "info",
    group: "camera",
  },

  // --- Action lịch sử: route đã đổi tên hoặc bỏ, nhưng dữ liệu cũ VẪN nằm
  // trong audit_logs và vẫn hiện ra màn hình. Grep mã nguồn không thấy các
  // action này (đã kiểm DB ngày 25/09/2026) — xoá khỏi đây là người dùng
  // nhìn thấy mã trần khi xem lại lịch sử cũ.
  "camera.test_connection": {
    label: "Kiểm tra kết nối camera",
    withTarget: "đã kiểm tra kết nối camera {target}",
    severity: "info",
    group: "camera",
  },
  "camera.recording.start": {
    label: "Bật ghi hình",
    withTarget: "đã bật ghi hình camera {target}",
    severity: "info",
    group: "camera",
  },
  "camera.recording.stop": {
    label: "Tắt ghi hình",
    withTarget: "đã tắt ghi hình camera {target}",
    severity: "warning",
    group: "camera",
  },
  "camera.recording.restart": {
    label: "Khởi động lại ghi hình",
    withTarget: "đã khởi động lại ghi hình camera {target}",
    severity: "warning",
    group: "camera",
  },
  "camera.recording.restart.enqueued": {
    label: "Khởi động lại ghi hình",
    withTarget: "đã khởi động lại ghi hình camera {target}",
    severity: "warning",
    group: "camera",
  },
  "camera.recording.sync_files": {
    label: "Đồng bộ file ghi hình",
    withTarget: "đã đồng bộ file ghi hình của camera {target}",
    severity: "info",
    group: "camera",
  },
  "camera.record_test": {
    label: "Ghi thử một đoạn",
    withTarget: "đã ghi thử một đoạn từ camera {target}",
    severity: "info",
    group: "camera",
  },
  "order_proof.clip.generate": {
    label: "Tạo video bằng chứng đơn hàng",
    severity: "info",
    group: "kho",
  },
  "order_proof.clip.regenerate": {
    label: "Tạo lại video bằng chứng đơn hàng",
    severity: "info",
    group: "kho",
  },

  // --- Người dùng hệ thống ---
  "user.create": {
    label: "Tạo người dùng",
    withTarget: "đã tạo người dùng {target}",
    severity: "warning",
    group: "nguoi-dung",
  },
  "user.update": {
    label: "Sửa người dùng",
    withTarget: "đã sửa người dùng {target}",
    severity: "warning",
    group: "nguoi-dung",
  },
  "user.update+password": {
    label: "Sửa người dùng và đổi mật khẩu",
    withTarget: "đã sửa người dùng {target} và đổi mật khẩu",
    severity: "critical",
    group: "nguoi-dung",
  },
  "user.delete": {
    label: "Xoá người dùng",
    withTarget: "đã xoá người dùng {target}",
    severity: "critical",
    group: "nguoi-dung",
  },

  // --- Nhân sự kho ---
  "staff.create": {
    label: "Thêm nhân viên",
    withTarget: "đã thêm nhân viên {target}",
    severity: "info",
    group: "nhan-su",
  },
  "staff.update": {
    label: "Sửa nhân viên",
    withTarget: "đã sửa nhân viên {target}",
    severity: "info",
    group: "nhan-su",
  },
  "staff.delete": {
    label: "Xoá nhân viên",
    withTarget: "đã xoá nhân viên {target}",
    severity: "critical",
    group: "nhan-su",
  },
  "staff.qr.regenerate": {
    label: "Cấp lại mã QR",
    withTarget: "đã cấp lại mã QR cho {target}",
    severity: "warning",
    group: "nhan-su",
  },
  "staff.invite": {
    label: "Mời nhân viên vào hệ thống",
    withTarget: "đã mời {target} vào hệ thống",
    severity: "warning",
    group: "nhan-su",
  },
  "staff.link_user": {
    label: "Gắn nhân viên với tài khoản",
    withTarget: "đã gắn nhân viên {target} với một tài khoản",
    severity: "warning",
    group: "nhan-su",
  },
  "staff.unlink_user": {
    label: "Gỡ tài khoản khỏi nhân viên",
    withTarget: "đã gỡ tài khoản khỏi nhân viên {target}",
    severity: "warning",
    group: "nhan-su",
  },

  // --- Kho, bàn đóng gói, tổ chức ---
  "warehouse.create": {
    label: "Tạo kho",
    withTarget: "đã tạo kho {target}",
    severity: "warning",
    group: "kho",
  },
  "warehouse.update": {
    label: "Sửa thông tin kho",
    withTarget: "đã sửa thông tin kho {target}",
    severity: "warning",
    group: "kho",
  },
  "warehouse.delete": {
    label: "Xoá kho",
    withTarget: "đã xoá kho {target}",
    severity: "critical",
    group: "kho",
  },
  "warehouse.close_stale_sessions": {
    label: "Đóng ca làm việc bị bỏ quên",
    severity: "info",
    group: "kho",
  },
  "packing_station.create": {
    label: "Tạo bàn đóng gói",
    withTarget: "đã tạo bàn đóng gói {target}",
    severity: "info",
    group: "kho",
  },
  "packing_station.update": {
    label: "Sửa bàn đóng gói",
    withTarget: "đã sửa bàn đóng gói {target}",
    severity: "info",
    group: "kho",
  },
  "packing_station.archive": {
    label: "Ngừng dùng bàn đóng gói",
    withTarget: "đã ngừng dùng bàn đóng gói {target}",
    severity: "warning",
    group: "kho",
  },
  "organization.update": {
    label: "Cập nhật thông tin tổ chức",
    severity: "warning",
    group: "kho",
  },
  "return_claim.update": {
    label: "Cập nhật khiếu nại hoàn hàng",
    severity: "info",
    group: "kho",
  },

  // --- Thiết bị & máy trạm kho ---
  "station_device.create": {
    label: "Thêm thiết bị kho",
    withTarget: "đã thêm thiết bị {target}",
    severity: "info",
    group: "thiet-bi",
  },
  "station_device.update": {
    label: "Sửa thiết bị kho",
    withTarget: "đã sửa thiết bị {target}",
    severity: "info",
    group: "thiet-bi",
  },
  "station_device.archive": {
    label: "Ngừng dùng thiết bị kho",
    withTarget: "đã ngừng dùng thiết bị {target}",
    severity: "warning",
    group: "thiet-bi",
  },
  "station_device_assignment.assign": {
    label: "Gán thiết bị vào bàn",
    severity: "info",
    group: "thiet-bi",
  },
  "station_device_assignment.unassign": {
    label: "Gỡ thiết bị khỏi bàn",
    severity: "info",
    group: "thiet-bi",
  },
  "warehouse_agent.create": {
    label: "Thêm máy trạm kho",
    withTarget: "đã thêm máy trạm kho {target}",
    severity: "warning",
    group: "thiet-bi",
  },
  "warehouse_agent.delete": {
    label: "Xoá máy trạm kho",
    withTarget: "đã xoá máy trạm kho {target}",
    severity: "critical",
    group: "thiet-bi",
  },
  "warehouse_agent.reset_secret": {
    label: "Cấp lại mã bí mật máy trạm",
    withTarget: "đã cấp lại mã bí mật cho máy trạm {target}",
    severity: "critical",
    group: "thiet-bi",
  },

  // --- Tài khoản của chính người dùng ---
  "account.change_password": {
    label: "Tự đổi mật khẩu",
    severity: "warning",
    group: "tai-khoan",
  },
  "account.password_fail": {
    label: "Đổi mật khẩu không thành công",
    severity: "warning",
    group: "tai-khoan",
  },
  "account.self_update": {
    label: "Tự sửa thông tin cá nhân",
    severity: "info",
    group: "tai-khoan",
  },
};

/** Tên trường kỹ thuật → tên người đọc hiểu, dùng cho bảng "đổi từ → sang". */
const FIELD_LABELS: Record<string, string> = {
  name: "Tên",
  full_name: "Họ tên",
  email: "Email",
  phone: "Số điện thoại",
  role: "Vai trò",
  status: "Trạng thái",
  is_active: "Đang hoạt động",
  location: "Vị trí",
  note: "Ghi chú",
  notes: "Ghi chú",
  code: "Mã",
  camera_code: "Mã camera",
  staff_code: "Mã nhân viên",
  ip: "Địa chỉ IP",
  rtsp_port: "Cổng RTSP",
  rtsp_path: "Đường dẫn luồng chính",
  rtsp_substream_path: "Đường dẫn luồng phụ",
  username: "Tên đăng nhập",
  warehouse_id: "Kho",
  packing_station_id: "Bàn đóng gói",
  retention_days: "Số ngày lưu video",
  device_type: "Loại thiết bị",
  serial_number: "Số sê-ri",
  // Các trường có thật trong dữ liệu (đối chiếu audit_logs ngày 25/09/2026).
  return_retention_days: "Số ngày lưu video hoàn hàng",
  config_json: "Cấu hình thiết bị",
  connection_type: "Kiểu kết nối",
  device_identity: "Định danh thiết bị",
  scan_source: "Nguồn quét mã",
  notify_lark_enabled: "Bật thông báo Lark",
  notify_lark_webhook_url: "Địa chỉ nhận thông báo Lark",
  notify_lark_digest_daily: "Báo cáo Lark hằng ngày",
  notify_lark_digest_weekly: "Báo cáo Lark hằng tuần",
  notify_lark_digest_monthly: "Báo cáo Lark hằng tháng",
};

/**
 * Trường có giá trị là khối JSON lớn (VD `config_json`: 26 lần trong dữ liệu
 * thật). Đổ nguyên ra bảng thì chiếm cả màn hình và không ai đọc — chỉ nói
 * "đã thay đổi", chi tiết để dành cho người điều tra đọc bằng công cụ khác.
 */
const OPAQUE_FIELDS = new Set(["config_json", "device_identity"]);

const ROLE_LABELS: Record<string, string> = {
  owner: "Chủ sở hữu",
  admin: "Quản trị",
  warehouse_manager: "Trưởng kho",
  viewer: "Chỉ xem",
  packer: "Nhân viên đóng gói",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Đang dùng",
  inactive: "Ngừng dùng",
  archived: "Đã lưu trữ",
  disabled: "Đã khoá",
};

/** Tên loại đối tượng, dùng khi action lạ và ta chỉ biết `target_type`. */
const TARGET_TYPE_LABELS: Record<string, string> = {
  camera: "camera",
  user: "người dùng",
  staff: "nhân viên",
  warehouse: "kho",
  packing_station: "bàn đóng gói",
  station_device: "thiết bị kho",
  warehouse_agent: "máy trạm kho",
  organization: "tổ chức",
  station_device_assignment: "gán thiết bị vào bàn",
  packing_event: "lượt đóng gói",
};

function labelForField(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** Giá trị thô → chữ đọc được. Giữ nguyên khi không biết, không bịa. */
function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "(trống)";
  if (typeof value === "boolean") return value ? "Có" : "Không";
  if (OPAQUE_FIELDS.has(field)) return "(đã thay đổi)";
  // URL webhook mang token gửi tin — không bày ra trang mà cả trưởng kho đọc được.
  if (field === "notify_lark_webhook_url") return "(đã thay đổi)";
  if (field === "role" && typeof value === "string") {
    return ROLE_LABELS[value] ?? value;
  }
  if (field === "status" && typeof value === "string") {
    return STATUS_LABELS[value] ?? value;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Đổi-từ-gì-sang-gì. Hai dạng metadata cùng tồn tại trong dữ liệu cũ:
 *   - `changes: { ip: { from, to } }`  (camera.update, từ 16/09/2026)
 *   - `changes: { ip: "1.2.3.4" }`     (các route khác, chỉ có giá trị mới)
 * Dạng sau chỉ hiện được vế "sang", không bịa vế "từ".
 */
export function extractChanges(
  metadata: Record<string, unknown> | null,
): AuditChange[] {
  const raw = metadata?.changes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];

  const out: AuditChange[] = [];
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ("from" in value || "to" in value)
    ) {
      const pair = value as { from?: unknown; to?: unknown };
      out.push({
        field,
        label: labelForField(field),
        from: formatValue(field, pair.from),
        to: formatValue(field, pair.to),
      });
    } else {
      out.push({
        field,
        label: labelForField(field),
        from: "—",
        to: formatValue(field, value),
      });
    }
  }
  return out;
}

/**
 * Tên đối tượng để hiện. Ưu tiên tên tra được ở server; không có thì lấy từ
 * metadata (route xoá thường chụp lại `full_name` / `staff_code` trước khi
 * xoá); vẫn không có thì chịu — trả null chứ không hiện UUID.
 */
export function resolveTargetLabel(row: AuditRowInput): string | null {
  if (row.target_name) return row.target_name;
  const md = row.metadata ?? {};
  for (const key of ["full_name", "name", "camera_name", "staff_code", "code", "email"]) {
    const v = md[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Ghi chú thêm — những mẩu metadata đáng nói thành lời. */
function buildNotes(row: AuditRowInput): string[] {
  const md = row.metadata ?? {};
  const notes: string[] = [];

  if (md.password_changed === true && row.action !== "user.update+password") {
    notes.push("Có đổi mật khẩu kèm theo");
  }
  if (typeof md.previous_role === "string") {
    notes.push(`Vai trò trước đó: ${ROLE_LABELS[md.previous_role] ?? md.previous_role}`);
  }
  if (md.auth_ban_failed) {
    notes.push("Cảnh báo: khoá đăng nhập chưa áp được, cần kiểm tra lại");
  }
  if (typeof md.reason === "string" && md.reason.trim()) {
    notes.push(`Lý do: ${md.reason.trim()}`);
  }
  if (typeof md.closed_count === "number") {
    notes.push(`Đã đóng ${md.closed_count} ca`);
  }
  return notes;
}

/**
 * Action chưa khai ở `ACTIONS`. Dựng nhãn tạm đọc được từ chính mã action
 * thay vì để lộ `station_device_assignment.assign` ra màn hình.
 */
function fallbackSpec(action: string, targetType: string | null): ActionSpec {
  const verb = action.split(".").pop() ?? action;
  const VERBS: Record<string, string> = {
    create: "Tạo",
    update: "Sửa",
    delete: "Xoá",
    archive: "Ngừng dùng",
    assign: "Gán",
    unassign: "Gỡ",
    start: "Bắt đầu",
    stop: "Dừng",
  };
  const objectName = targetType ? TARGET_TYPE_LABELS[targetType] ?? targetType : "";
  const verbLabel = VERBS[verb];
  const label = verbLabel
    ? `${verbLabel}${objectName ? ` ${objectName}` : ""}`
    : `Thao tác hệ thống${objectName ? ` với ${objectName}` : ""}`;

  return {
    label,
    severity: verb === "delete" || verb === "archive" ? "critical" : "info",
    group: "khac",
  };
}

export function presentAudit(row: AuditRowInput): PresentedAudit {
  const spec = ACTIONS[row.action] ?? fallbackSpec(row.action, row.target_type);
  const targetLabel = resolveTargetLabel(row);
  const actorLabel = row.actor_email ?? "Hệ thống";

  // Câu đầy đủ. Có mẫu `withTarget` + biết tên → câu tự nhiên; thiếu một
  // trong hai → vẫn phải là câu có vị ngữ ("đã xoá camera"), không phải mẩu
  // cụt ("xoá camera") — người đọc không nhận ra đó là một câu.
  const predicate =
    spec.withTarget && targetLabel
      ? spec.withTarget.replace("{target}", `“${targetLabel}”`)
      : `đã ${spec.label.charAt(0).toLowerCase()}${spec.label.slice(1)}`;

  return {
    id: row.id,
    title: spec.label,
    sentence: `${actorLabel} ${predicate}`,
    actorLabel,
    targetLabel,
    severity: spec.severity,
    group: spec.group,
    notes: buildNotes(row),
    changes: extractChanges(row.metadata),
    createdAt: row.created_at,
    action: row.action,
  };
}

/** Nhãn nhóm cho dropdown lọc. */
export const GROUP_LABELS: Record<AuditGroup, string> = {
  camera: "Camera",
  "nguoi-dung": "Người dùng hệ thống",
  "nhan-su": "Nhân sự kho",
  kho: "Kho & bàn đóng gói",
  "thiet-bi": "Thiết bị & máy trạm",
  "tai-khoan": "Tài khoản cá nhân",
  khac: "Khác",
};

export const SEVERITY_LABELS: Record<AuditSeverity, string> = {
  critical: "Quan trọng",
  warning: "Cần chú ý",
  info: "Thông thường",
};

/** Mọi action đã khai — test dùng để canh route mới không bị bỏ quên. */
export function knownActions(): string[] {
  return Object.keys(ACTIONS);
}
