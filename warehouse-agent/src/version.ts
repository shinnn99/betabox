/**
 * Phiên bản agent — gửi lên cloud trong bản tự khai mỗi nhịp tim.
 *
 * Trước 0.13.0 phiên bản chỉ nằm trong package.json và tên file cài đặt;
 * để biết máy kho chạy bản nào phải đọc KÍCH THƯỚC FILE EXE (25/09/2026).
 *
 * Phát hành bản mới thì sửa CÙNG LÚC: file này, package.json,
 * installer/betacom-agent.iss, RELEASES.md, và LATEST_AGENT_VERSION phía
 * cloud (src/lib/warehouse/self-report.ts). Có test canh bốn chỗ đầu khớp nhau.
 */
export const AGENT_VERSION = "0.13.0";
