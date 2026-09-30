import { readFileSync } from "node:fs";

/**
 * Đọc file nguồn để SOI NỘI DUNG trong test, đã chuẩn hoá xuống dòng.
 *
 * Vì sao cần: nhiều bài test canh một đoạn mã nhiều dòng bằng cách tìm
 * chuỗi có `\n` ở giữa (ví dụ `"      config,\n    ],"`). Trên máy
 * Windows, Git checkout ra CRLF nên trong file thật đoạn đó là `\r\n` —
 * chuỗi không khớp và bài test đỏ, DÙ MÃ NGUỒN HOÀN TOÀN ĐÚNG.
 *
 * Đây là bẫy khó thấy: lỗi trông như "thiếu đăng ký vào runSystemChecks"
 * trong khi dòng đó vẫn nằm đúng chỗ. Đã mất một lượt truy ngược mới ra
 * (30/09/2026), nên gom về một hàm thay vì để mỗi bài tự đọc.
 *
 * Chỉ dùng cho test soi nội dung file nguồn. Không dùng để đọc dữ liệu
 * cần giữ nguyên byte.
 */
export function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}
