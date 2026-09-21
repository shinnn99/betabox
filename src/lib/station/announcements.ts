/**
 * Kho câu thông báo cho màn hình bàn đóng hàng.
 *
 * Vì sao gom một chỗ: mỗi thông báo có HAI dạng — chữ hiện trên toast
 * (kèm mã đơn/tên nhân viên để tra cứu) và câu đọc thành tiếng (ngắn,
 * không đọc mã dài vì nhân viên đang cầm hàng, nghe số vô nghĩa). Nếu
 * để rải trong route thì hai dạng này lệch nhau rất nhanh.
 *
 * `id` phải ĐỔI mỗi khi trạng thái đổi, kể cả khi vẫn là một đơn:
 * client so `id` với lần poll trước để quyết định có đọc lại không.
 * Do đó id gắn thêm hậu tố trạng thái (`:auto_stopped`), không chỉ
 * là khoá chính của row.
 */

export type AnnouncementLevel = "success" | "warning" | "error";

export interface StationAnnouncement {
  id: string;
  occurred_at: string;
  level: AnnouncementLevel;
  /** Chữ hiện trên toast. */
  message: string;
  /** Câu đọc thành tiếng (vi-VN). */
  speech: string;
}

/** Hành động trong `staff_qr_scan_results.action`. */
export type StaffScanAction =
  | "checked_in"
  | "checked_out"
  | "switched_station"
  | "replaced_staff"
  | (string & {});

export function buildStaffSessionAnnouncement(input: {
  id: string;
  action: StaffScanAction;
  warningCode: string | null;
  message: string | null;
  createdAt: string;
  staffLabel: string;
}): StationAnnouncement {
  const base = { id: `session:${input.id}`, occurred_at: input.createdAt };

  if (input.warningCode) {
    return {
      ...base,
      level: "error",
      message: input.message ?? "QR nhân viên không hợp lệ",
      speech: "Mã nhân viên không hợp lệ",
    };
  }

  switch (input.action) {
    case "checked_in":
      return {
        ...base,
        level: "success",
        message: `Mở ca thành công · ${input.staffLabel}`,
        speech: "Mở ca thành công",
      };
    case "checked_out":
      return {
        ...base,
        level: "success",
        message: `Kết thúc ca · ${input.staffLabel}`,
        speech: "Kết thúc ca, đã dừng ghi hình",
      };
    case "switched_station":
      return {
        ...base,
        level: "success",
        message: `Chuyển bàn · ${input.staffLabel}`,
        speech: "Đã chuyển bàn, tiếp tục ghi hình",
      };
    case "replaced_staff":
      return {
        ...base,
        level: "success",
        message: `Thay nhân viên · ${input.staffLabel}`,
        speech: "Đã thay nhân viên",
      };
    default:
      return {
        ...base,
        level: "error",
        message: input.message ?? "QR nhân viên không hợp lệ",
        speech: "Mã nhân viên không hợp lệ",
      };
  }
}

export function buildPackingScanAnnouncement(input: {
  id: string;
  status: string | null;
  waybillCode: string | null;
  scannedAt: string;
}): StationAnnouncement {
  const base = { id: `packing:${input.id}`, occurred_at: input.scannedAt };
  const waybill = input.waybillCode || "không đọc được mã";

  switch (input.status) {
    case "valid":
      return {
        ...base,
        level: "success",
        message: `Bắt đầu quay video · ${waybill}`,
        speech: "Bắt đầu quay video",
      };
    case "duplicated":
      return {
        ...base,
        level: "warning",
        message: `Mã đã quét · ${waybill}`,
        speech: "Mã đơn này đã được quét",
      };
    case "no_active_session":
      return {
        ...base,
        level: "error",
        message: "Chưa mở ca nên không quay được",
        speech: "Chưa mở ca, chưa quay được video",
      };
    // Lưới an toàn: mã này đã đóng gửi đi ở một ngày trước, nên gần như
    // chắc chắn là kiện hàng hoàn quay về. Không tính vào số đơn.
    case "return_suspect":
      return {
        ...base,
        level: "warning",
        message: `Hàng hoàn · ${waybill} đã đóng trước đó`,
        speech: "Mã này đã đóng trước đó. Đây là hàng hoàn, không tính đơn",
      };
    default:
      return {
        ...base,
        level: "error",
        message: `Không xử lý được mã quét · ${waybill}`,
        speech: "Không xử lý được mã quét",
      };
  }
}

/**
 * Bàn vừa đổi chế độ.
 *
 * Nhân viên phải biết bàn đang ở chế độ nào TRƯỚC khi quét mã tiếp theo:
 * cùng một mã, quét ở chế độ đóng hàng thì thành đơn đi (được đếm), quét ở
 * chế độ nhận hoàn thì thành kiện hoàn (không đếm).
 *
 * `startedBy`:
 *   card    — nhân viên quét thẻ;
 *   system  — hệ thống tự đưa về (5 phút không thao tác, hoặc đóng ca);
 *   purpose — chủ kho đổi chế độ mặc định của bàn trên giao diện.
 */
export function buildStationModeAnnouncement(input: {
  periodId: string;
  mode: "outbound" | "return";
  startedAt: string;
  startedBy: string | null;
}): StationAnnouncement {
  const base = { id: `mode:${input.periodId}`, occurred_at: input.startedAt };
  if (input.mode === "return") {
    return {
      ...base,
      level: "warning",
      message: "Chế độ NHẬN HÀNG HOÀN · mã quét không tính vào số đơn",
      speech: "Đã chuyển sang chế độ nhận hàng hoàn",
    };
  }
  return {
    ...base,
    level: "success",
    message:
      input.startedBy === "system"
        ? "Đã tự về chế độ đóng hàng"
        : "Chế độ đóng hàng",
    speech:
      input.startedBy === "system"
        ? "Đã tự về chế độ đóng hàng"
        : "Đã về chế độ đóng hàng",
  };
}

/**
 * Đơn bị cưỡng chế dừng vì quá trần thời gian.
 *
 * Câu chữ do nghiệp vụ chốt, đừng sửa tuỳ tiện: nhân viên nghe câu này
 * là biết video của đơn vừa rồi đã khoá, quét mã mới để đóng đơn tiếp.
 */
export function buildAutoStopAnnouncement(input: {
  id: string;
  waybillCode: string | null;
  workEndedAt: string;
  limitSeconds: number;
}): StationAnnouncement {
  const waybill = input.waybillCode || "đơn đang mở";
  return {
    id: `packing:${input.id}:auto_stopped`,
    occurred_at: input.workEndedAt,
    level: "error",
    message: `Video quá thời gian quy định, tự động dừng · ${waybill} (trần ${input.limitSeconds}s)`,
    speech: "Video quá thời gian quy định, tự động dừng",
  };
}

/**
 * Có đơn đang mở nhưng không camera nào của bàn đang ghi.
 *
 * Đây là lỗi mất bằng chứng — nhân viên vẫn đóng hàng bình thường mà
 * không hề biết sẽ không có video để xuất cho khách.
 */
export function buildRecordingGapAnnouncement(input: {
  stationId: string;
  waybillCode: string | null;
  since: string;
}): StationAnnouncement {
  const waybill = input.waybillCode ? ` · ${input.waybillCode}` : "";
  return {
    id: `recording-gap:${input.stationId}:${input.since}`,
    occurred_at: input.since,
    level: "error",
    message: `Camera chưa ghi hình${waybill} — kiểm tra kết nối camera`,
    speech: "Cảnh báo, camera chưa ghi hình",
  };
}
