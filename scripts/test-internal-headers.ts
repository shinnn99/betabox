// Test round-trip nền crypto internal-headers-core.
// 5 ca: round-trip / sig hỏng / expired / null / khác-secret.
//
// Chạy: node --experimental-strip-types --env-file=.env.local scripts/test-internal-headers.ts

import { createHmac } from "crypto";
import { randomUUID } from "crypto";
import {
  signOrgContext,
  verifyOrgContext,
  type VerifyResult,
} from "../src/lib/platform/internal-headers-core.ts";
import { stripInternalHeadersInPlace } from "../src/lib/platform/headers-strip-core.ts";

interface TestCase {
  name: string;
  expected: {
    valid: boolean;
    reason?: string;
    orgId?: string;
  };
  actual?: VerifyResult;
  pass?: boolean;
}

const tests: TestCase[] = [];

// ============================================================================
// CA 1: Round-trip đúng — sign rồi verify trả valid:true, orgId khớp
// ============================================================================
{
  const orgId = randomUUID();
  const timestamp = Date.now();
  const nonce = randomUUID();
  const token = await signOrgContext({ orgId, timestamp, nonce });
  const result = await verifyOrgContext(token);
  tests.push({
    name: "1. Round-trip đúng",
    expected: { valid: true, orgId },
    actual: result,
    pass: result.valid && result.orgId === orgId,
  });
}

// ============================================================================
// CA 2: Sig hỏng — sửa 1 ký tự phần sig
// ============================================================================
{
  const orgId = randomUUID();
  const token = await signOrgContext({
    orgId,
    timestamp: Date.now(),
    nonce: randomUUID(),
  });
  // Sửa ký tự cuối của sig
  const brokenToken = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
  const result = await verifyOrgContext(brokenToken);
  tests.push({
    name: "2. Sig hỏng (1 char thay)",
    expected: { valid: false, reason: "sig_mismatch" },
    actual: result,
    pass: !result.valid && result.reason === "sig_mismatch",
  });
}

// ============================================================================
// CA 3: Expired — timestamp lùi 6 phút (TTL 5 phút)
// ============================================================================
{
  const orgId = randomUUID();
  const timestamp = Date.now() - 6 * 60 * 1000; // 6 phút trước
  const token = await signOrgContext({
    orgId,
    timestamp,
    nonce: randomUUID(),
  });
  const result = await verifyOrgContext(token);
  tests.push({
    name: "3. Expired (timestamp -6 phút)",
    expected: { valid: false, reason: "expired" },
    actual: result,
    pass: !result.valid && result.reason === "expired",
  });
}

// ============================================================================
// CA 4: Null token
// ============================================================================
{
  const result = await verifyOrgContext(null);
  tests.push({
    name: "4. Null token",
    expected: { valid: false, reason: "no_token" },
    actual: result,
    pass: !result.valid && result.reason === "no_token",
  });
}

// ============================================================================
// CA 5: Khác secret — ký bằng secret khác, verify với secret production phải fail
// ============================================================================
{
  const orgId = randomUUID();
  const payload = {
    orgId,
    timestamp: Date.now(),
    nonce: randomUUID(),
  };
  const body = JSON.stringify(payload);
  const bodyB64 = Buffer.from(body).toString("base64url");
  const FAKE_SECRET = "fake_secret_different_from_production_min32chars_xxxx";
  const fakeSig = createHmac("sha256", FAKE_SECRET)
    .update(bodyB64)
    .digest("base64url");
  const fakeToken = `${bodyB64}.${fakeSig}`;
  const result = await verifyOrgContext(fakeToken);
  tests.push({
    name: "5. Khác secret (fake sign)",
    expected: { valid: false, reason: "sig_mismatch" },
    actual: result,
    pass: !result.valid && result.reason === "sig_mismatch",
  });
}

// ============================================================================
// CA 6-10: STRIP standalone — hàm thuần, phủ biến thể case/suffix
// ============================================================================

// Helper: tạo request giả với headers cho trước
function mockRequest(headers: Record<string, string>): { headers: Headers } {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.append(k, v);
  return { headers: h };
}

// CA 6: strip lowercase x-internal-org-ctx
{
  const req = mockRequest({
    "x-internal-org-ctx": "should-be-stripped",
    "cookie": "sb-auth=preserve-me",
  });
  stripInternalHeadersInPlace(req);
  const stripped = req.headers.get("x-internal-org-ctx") === null;
  const cookieKept = req.headers.get("cookie") === "sb-auth=preserve-me";
  tests.push({
    name: "6. Strip lowercase x-internal-org-ctx (cookie giữ nguyên)",
    expected: { valid: true },
    actual: { valid: stripped && cookieKept, reason: !stripped ? "not-stripped" : !cookieKept ? "cookie-lost" : "ok" },
    pass: stripped && cookieKept,
  });
}

// CA 7: strip mixed-case X-Internal-Org-Ctx
{
  const req = mockRequest({ "X-Internal-Org-Ctx": "mixed-case" });
  stripInternalHeadersInPlace(req);
  const stripped = req.headers.get("x-internal-org-ctx") === null;
  tests.push({
    name: "7. Strip mixed-case X-Internal-Org-Ctx",
    expected: { valid: true },
    actual: { valid: stripped, reason: stripped ? "ok" : "not-stripped" },
    pass: stripped,
  });
}

// CA 8: strip UPPERCASE X-INTERNAL-ORG-CTX
{
  const req = mockRequest({ "X-INTERNAL-ORG-CTX": "upper" });
  stripInternalHeadersInPlace(req);
  const stripped = req.headers.get("x-internal-org-ctx") === null;
  tests.push({
    name: "8. Strip UPPERCASE X-INTERNAL-ORG-CTX",
    expected: { valid: true },
    actual: { valid: stripped, reason: stripped ? "ok" : "not-stripped" },
    pass: stripped,
  });
}

// CA 9: strip ARBITRARY suffix x-internal-anything
{
  const req = mockRequest({
    "x-internal-actor": "future-header",
    "x-internal-ip-audit": "10.0.0.1",
    "x-internal-org-ctx": "org-token",
  });
  stripInternalHeadersInPlace(req);
  const a = req.headers.get("x-internal-actor") === null;
  const b = req.headers.get("x-internal-ip-audit") === null;
  const c = req.headers.get("x-internal-org-ctx") === null;
  tests.push({
    name: "9. Strip ARBITRARY suffix (actor / ip-audit / org-ctx)",
    expected: { valid: true },
    actual: { valid: a && b && c, reason: `actor:${a} ip-audit:${b} org-ctx:${c}` },
    pass: a && b && c,
  });
}

// CA 10: KHÔNG strip header không phải x-internal-* (giữ x-request-id, authorization, etc)
{
  const req = mockRequest({
    "x-internal-org-ctx": "strip-me",
    "x-request-id": "keep-me",
    "authorization": "Bearer token",
    "cookie": "sb-auth=xyz",
    "user-agent": "curl/8.0",
  });
  stripInternalHeadersInPlace(req);
  const strippedTarget = req.headers.get("x-internal-org-ctx") === null;
  const keptA = req.headers.get("x-request-id") === "keep-me";
  const keptB = req.headers.get("authorization") === "Bearer token";
  const keptC = req.headers.get("cookie") === "sb-auth=xyz";
  const keptD = req.headers.get("user-agent") === "curl/8.0";
  const allOk = strippedTarget && keptA && keptB && keptC && keptD;
  tests.push({
    name: "10. Chỉ strip x-internal-*, giữ header khác nguyên vẹn",
    expected: { valid: true },
    actual: { valid: allOk, reason: `stripped:${strippedTarget} kept: req-id:${keptA} auth:${keptB} cookie:${keptC} ua:${keptD}` },
    pass: allOk,
  });
}

// ============================================================================
// REPORT
// ============================================================================
console.log("\n=== Test internal-headers-core round-trip ===\n");
let failed = 0;
for (const t of tests) {
  const mark = t.pass ? "✓" : "✗";
  console.log(`${mark} ${t.name}`);
  console.log(`  expected: ${JSON.stringify(t.expected)}`);
  console.log(`  actual:   ${JSON.stringify(t.actual)}`);
  if (!t.pass) failed++;
}
console.log(`\n${tests.length} tests, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
