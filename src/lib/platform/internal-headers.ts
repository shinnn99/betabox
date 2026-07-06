import "server-only";
// Re-export core hàm để proxy.ts/guard.ts import từ đây không đổi.
// Tách theo ranh giới phụ thuộc:
//   - crypto core (không server-only, test standalone) — internal-headers-core.ts
//   - strip core (không server-only, test standalone) — headers-strip-core.ts
//   - file này wrap 2 core + server-only (đảm bảo module chỉ vào server bundle).
export {
  signOrgContext,
  verifyOrgContext,
  TOKEN_TTL_MS,
  type OrgContextPayload,
  type VerifyResult,
} from "./internal-headers-core";

export { stripInternalHeadersInPlace } from "./headers-strip-core";
