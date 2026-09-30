import type { Role } from "@/lib/auth";

export interface RbacRoleDefinition {
  code: Role;
  label: string;
  description: string;
  lockedFullAccess?: boolean;
}

export interface PermissionDefinition {
  code: string;
  group: string;
  label: string;
  description: string;
}

export const RBAC_ROLES: readonly RbacRoleDefinition[] = [
  {
    code: "owner",
    label: "Chủ sở hữu",
    description: "Toàn quyền trong tổ chức.",
    lockedFullAccess: true,
  },
  {
    code: "admin",
    label: "Quản trị hệ thống",
    description: "Toàn quyền vận hành, không thay thế chủ sở hữu.",
    lockedFullAccess: true,
  },
  {
    code: "warehouse_manager",
    label: "Trưởng kho",
    description: "Xem toàn bộ; quản lý tài khoản có vai trò thấp hơn.",
  },
  {
    code: "shift_leader",
    label: "Trưởng ca",
    description: "Quyền vận hành ca do Platform cấu hình.",
  },
  {
    code: "packer",
    label: "Nhân viên đóng gói",
    description: "Chỉ xem vận hành tại bàn phụ trách và video.",
  },
  {
    code: "viewer",
    label: "Quan sát viên",
    description: "Chỉ xem tổng quan, vận hành và bằng chứng.",
  },
] as const;

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  { code: "dashboard.view", group: "Tổng quan", label: "Xem Bảng điều khiển", description: "Mở trang tổng quan và các chỉ số trong ngày." },

  { code: "warehouse.view", group: "Vận hành kho", label: "Xem giám sát đóng/hoàn hàng", description: "Xem trạng thái vận hành, bàn và hoạt động trong kho." },
  { code: "order_proof.view", group: "Vận hành kho", label: "Xem bằng chứng giao/hoàn hàng", description: "Tra cứu và phát video bằng chứng." },
  { code: "video.view", group: "Vận hành kho", label: "Phát video bằng chứng", description: "Phát video trong trình duyệt." },
  { code: "video.download", group: "Vận hành kho", label: "Tải video bằng chứng", description: "Tải tệp video bằng chứng về máy." },
  { code: "order_proof.generate", group: "Vận hành kho", label: "Tạo lại và đánh dấu video", description: "Tạo lại clip hoặc đánh dấu đơn lỗi." },
  { code: "return.operate", group: "Vận hành kho", label: "Vận hành nhận hoàn", description: "Mở/đóng phiên nhận hoàn và cập nhật hồ sơ." },
  { code: "live.view_station", group: "Vận hành kho", label: "Xem trực tiếp bàn phụ trách", description: "Xem camera trực tiếp của bàn được phân công." },
  { code: "live.view_remote", group: "Vận hành kho", label: "Xem trực tiếp mọi bàn", description: "Xem camera trực tiếp từ xa trên toàn tổ chức." },

  { code: "organization.view", group: "Quản lý kho", label: "Xem thông tin tổ chức", description: "Xem hồ sơ tổ chức." },
  { code: "organization.update", group: "Quản lý kho", label: "Sửa thông tin tổ chức", description: "Cập nhật thông tin tổ chức." },
  { code: "packing_station.view", group: "Quản lý kho", label: "Xem kho và bàn đóng hàng", description: "Mở trang Tổ chức & Kho và Bàn đóng hàng." },
  { code: "warehouse.create", group: "Quản lý kho", label: "Thêm kho", description: "Tạo kho mới trong tổ chức." },
  { code: "warehouse.update", group: "Quản lý kho", label: "Sửa và cấu hình kho", description: "Sửa kho, hạn lưu và cấu hình thông báo." },
  { code: "warehouse.delete", group: "Quản lý kho", label: "Xóa kho", description: "Xóa kho khỏi tổ chức." },
  { code: "packing_station.create", group: "Quản lý kho", label: "Thêm bàn đóng hàng", description: "Tạo bàn đóng hàng mới." },
  { code: "packing_station.update", group: "Quản lý kho", label: "Sửa bàn đóng hàng", description: "Đổi thông tin hoặc chế độ bàn." },
  { code: "packing_station.archive", group: "Quản lý kho", label: "Lưu trữ bàn đóng hàng", description: "Ngừng sử dụng một bàn." },
  { code: "packing_station.camera_setup", group: "Quản lý kho", label: "Cấu hình camera cho bàn", description: "Gắn camera chính/QR vào bàn." },
  { code: "station_device.view", group: "Quản lý kho", label: "Xem thiết bị và máy trạm", description: "Mở trang Thiết bị kho và Máy trạm kho." },
  { code: "station_device.create", group: "Quản lý kho", label: "Thêm thiết bị và máy trạm", description: "Tạo thiết bị, máy trạm hoặc cấp secret." },
  { code: "station_device.update", group: "Quản lý kho", label: "Sửa thiết bị", description: "Cập nhật thiết bị kho." },
  { code: "station_device.archive", group: "Quản lý kho", label: "Xóa/lưu trữ thiết bị", description: "Ngừng sử dụng thiết bị kho." },
  { code: "station_device_assignment.view", group: "Quản lý kho", label: "Xem gán thiết bị", description: "Xem thiết bị đang thuộc bàn nào." },
  { code: "station_device_assignment.manage", group: "Quản lý kho", label: "Gán thiết bị vào bàn", description: "Đổi bàn hoặc nguồn quét của thiết bị." },
  { code: "camera.view", group: "Quản lý kho", label: "Xem camera", description: "Xem danh sách và trạng thái camera." },
  { code: "camera.create", group: "Quản lý kho", label: "Thêm và dò camera", description: "Dò mạng hoặc khai báo camera mới." },
  { code: "camera.update", group: "Quản lý kho", label: "Sửa camera", description: "Cập nhật cấu hình kết nối camera." },
  { code: "camera.archive", group: "Quản lý kho", label: "Xóa/lưu trữ camera", description: "Ngừng sử dụng camera." },
  { code: "camera.test", group: "Quản lý kho", label: "Kiểm tra camera", description: "Test kết nối hoặc codec camera." },
  { code: "camera.recording.view", group: "Quản lý kho", label: "Xem trạng thái ghi hình", description: "Xem phiên và tình trạng ghi hình." },
  { code: "camera.recording.control", group: "Quản lý kho", label: "Điều khiển ghi hình", description: "Bắt đầu hoặc dừng ghi hình." },
  { code: "sensitive.view", group: "Quản lý kho", label: "Xem thông tin nhạy cảm", description: "Xem IP, RTSP, email và số điện thoại đầy đủ." },

  { code: "staff.view", group: "Nhân sự kho", label: "Xem nhân sự kho", description: "Xem danh sách nhân viên kho." },
  { code: "staff.create", group: "Nhân sự kho", label: "Thêm nhân sự", description: "Tạo hồ sơ nhân viên kho." },
  { code: "staff.update", group: "Nhân sự kho", label: "Sửa nhân sự", description: "Cập nhật hồ sơ nhân viên kho." },
  { code: "staff.delete", group: "Nhân sự kho", label: "Xóa nhân sự", description: "Xóa hồ sơ nhân viên kho." },
  { code: "staff.invite", group: "Nhân sự kho", label: "Liên kết tài khoản web", description: "Mời hoặc liên kết nhân viên với tài khoản." },
  { code: "staff.qr.regenerate", group: "Nhân sự kho", label: "Cấp lại mã QR", description: "Xem và cấp lại QR vào ca." },

  { code: "report.view", group: "Báo cáo", label: "Xem báo cáo hiệu suất", description: "Mở báo cáo vận hành và hiệu suất." },

  { code: "user.view", group: "Quản lý hệ thống", label: "Xem người dùng hệ thống", description: "Xem tài khoản truy cập web." },
  { code: "user.create", group: "Quản lý hệ thống", label: "Thêm người dùng", description: "Tạo tài khoản có vai trò thấp hơn." },
  { code: "user.update", group: "Quản lý hệ thống", label: "Sửa, nâng/hạ vai trò người dùng", description: "Sửa và đổi vai trò tài khoản trong phạm vi cấp bậc." },
  { code: "user.delete", group: "Quản lý hệ thống", label: "Xóa người dùng", description: "Xóa tài khoản có vai trò thấp hơn; vẫn chặn tự xóa và chủ cuối." },
] as const;

export const PERMISSION_CODES = new Set(PERMISSION_DEFINITIONS.map((permission) => permission.code));

export function permissionDefinition(code: string): PermissionDefinition {
  return PERMISSION_DEFINITIONS.find((permission) => permission.code === code) ?? {
    code,
    group: "Quyền khác",
    label: code,
    description: "Quyền cũ đang tồn tại trong hệ thống.",
  };
}
