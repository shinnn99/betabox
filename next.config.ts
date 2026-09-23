import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // BẮT BUỘC cho deploy VPS: quy trình trên máy chủ chạy
  // `.next/standalone/server.js` qua systemd, và các bước copy
  // (`cp -r .next/static .next/standalone/.next/`) giả định thư mục này
  // tồn tại. Thiếu dòng này thì `pnpm build` không sinh standalone và
  // deploy gãy ở bước copy.
  //
  // Lịch sử: dòng này từng chỉ tồn tại trong một commit LOCAL trên VPS
  // (8b1595a, 11/08, chưa từng push), nên repo không ai đọc ra được vì
  // sao deploy cần nó — khôi phục máy từ snapshot cũ hoặc clone mới là
  // gãy mà không rõ nguyên nhân. Đưa vào repo 12/08.
  output: "standalone",
  // Turbopack vẫn watch toàn bộ workspace dù tsconfig đã exclude.
  // Loại hẳn warehouse-agent ra khỏi file-watcher để cache không bị
  // invalidate khi cài/xóa node_modules của agent.
  turbopack: {
    rules: {},
  },
  outputFileTracingExcludes: {
    "*": ["warehouse-agent/**"],
  },
  // Cho phép máy khác trong LAN mở web dev qua IP máy dev. Next 16 mặc
  // định block cross-origin dev resource (HMR/webpack) ngoài localhost →
  // trình duyệt không hydrate client JS → form "đứng yên", đăng nhập không
  // được (gặp lại 22/09/2026 với 192.168.1.42).
  // IP máy dev đổi theo mạng (DHCP): 192.168.1.x, 192.168.31.x, … — Next so
  // khớp từng đoạn nên "192.168.*.*" phủ mọi IP LAN, khỏi sửa mỗi lần đổi.
  // Chỉ áp cho `next dev`; production không dùng tuỳ chọn này.
  allowedDevOrigins: ["192.168.*.*", "127.0.0.1"],
};

export default nextConfig;
