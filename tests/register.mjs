/**
 * Preload của bộ test — chạy trước mọi test module.
 *
 * Dùng qua `pnpm test`, không gọi tay.
 */
import { register } from "node:module";

/**
 * Vercel chạy TZ=UTC, và đó chính là nơi mọi lỗi lệch +7 giờ nổ (card Lark
 * từng hiện sai giờ vì thế). Test phải mặc định đứng ở môi trường đó chứ
 * không phải giờ máy dev — nếu không, đúng lớp bug đó sẽ xanh ở local.
 *
 * Ai cần chạy ở múi khác thì set TZ trước; giá trị đặt sẵn được tôn trọng.
 */
process.env.TZ ??= "UTC";

register("./resolve-ts.mjs", import.meta.url);
