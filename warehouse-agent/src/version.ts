/**
 * Phiên bản agent — gửi lên cloud trong bản tự khai mỗi nhịp tim.
 *
 * Trước 0.13.0 phiên bản chỉ nằm trong package.json và tên file cài đặt;
 * để biết máy kho chạy bản nào phải đọc KÍCH THƯỚC FILE EXE (25/09/2026).
 *
 * Phát hành bản mới thì sửa CÙNG LÚC SÁU chỗ:
 *   1. file này
 *   2. package.json
 *   3. installer/betacom-agent.iss
 *   4. RELEASES.md                        — ghi cho người đi cài
 *   5. LATEST_AGENT_VERSION phía cloud    — src/lib/warehouse/self-report.ts
 *   6. changelog/<ngày>.md                — mục "Phát hành cho người dùng",
 *      kèm `<!-- ban: agent=X -->`, rồi chạy lại `pnpm build:changelog`
 *
 * Hai bài test canh, và chúng canh HAI TẬP KHÁC NHAU — qua được bài đầu
 * không có nghĩa là xong:
 *   tests/self-report-0-13.test.ts  (agent) → chỗ 1-5
 *   tests/changelog-page.test.ts    (cloud) → chỗ 6
 * Chỗ 6 từng bị bỏ sót vì ghi chú ở đây chỉ kể năm chỗ (sửa 05/10/2026).
 */
export const AGENT_VERSION = "0.14.0";
