import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack vẫn watch toàn bộ workspace dù tsconfig đã exclude.
  // Loại hẳn warehouse-agent ra khỏi file-watcher để cache không bị
  // invalidate khi cài/xóa node_modules của agent.
  turbopack: {
    rules: {},
  },
  outputFileTracingExcludes: {
    "*": ["warehouse-agent/**"],
  },
  // Cho phép mobile trong LAN test qua IP máy dev. Next 16 mặc định
  // block cross-origin dev resource (HMR/webpack) ngoài localhost →
  // mobile không hydrate client JS → form "đứng yên" không submit.
  // IP này khớp cert mkcert (xem certs/localhost.pem SANs) — nếu đổi
  // IP LAN (Wi-Fi DHCP cấp lại) phải sinh cert mới + sửa đây.
  allowedDevOrigins: ["192.168.66.160", "127.0.0.1"],
};

export default nextConfig;
