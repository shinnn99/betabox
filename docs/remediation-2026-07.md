# Remediation Report — 2026-07-07 (revised for Vòng B bookkeeping)

Phiên Vòng A (scope hẹp: A1 + A2 + A3, KHÔNG chạm CRIT-1/-2/-5/-6, HMAC nonce, envelope encrypt, migration duplicate, rollback A2/A3, dead code deletion).

Bookkeeping revised 2026-07-07 để không "xanh hơn thực tế":
- CRIT-3 tách thành CRIT-3A (Node fatal-handler contract) + CRIT-3B (Windows Service restart).
- HIGH-15 tách thành HIGH-15A (critical writes đã fix) + HIGH-15B (28 write inventory còn mở).
- HIGH-10 thêm evidence + phạm vi rõ (không có PATCH tenant-facing, "UPDATE" trong report gốc = UPDATE column secret trong POST reset-secret).

## Baseline

- Branch: `fix/remediation-round-b` (từ `main` HEAD `dbb9f8e`).
- Package manager: pnpm (lock 2026-07-04).
- App typecheck (root `tsconfig.json`): PASS (0 error).
- Agent typecheck (`warehouse-agent/tsconfig.json`): PASS (0 error).
- Untracked: `query`, `supabase/rollback/` (giữ nguyên, không đụng theo yêu cầu).
- Không có test runner sẵn (0 jest/vitest). Sẽ dùng `node --test` built-in cho test mới.

## Status legend

- `verified` — đã kiểm root cause, chưa fix.
- `fixed-and-tested` — đã fix + test chứng minh hành vi thực tế (không phải mock rỗng); test cover cả positive và edge cases theo scope finding.
- `partially-fixed-and-tested` — phần fix đã có bằng chứng, phần còn lại đã verified/inventoried nhưng chưa fix trong phiên này.
- `fixed-and-production-validated` — deployment đã thành công trên prod thật (không disposable); postcondition guards pass; runtime evidence trực tiếp (positive path).
- `fixed-and-production-validated-with-negative-tests-pending` — deployment đã trên prod, positive runtime OK, NHƯNG negative/adversarial cross-tenant test cases chưa chạy trên disposable DB.
- `fixed-and-production-applied-needs-negative-path-validation` — deployment đã trên prod, function/migration đã áp dụng, NHƯNG chưa có positive runtime evidence trực tiếp (chưa có traffic chạy qua đủ path) và chưa chạy negative test.
- `fixed-needs-environment-validation` — code fix xong, cần môi trường thật (kho Windows / prod DB) mới xác nhận cuối.
- `not-applicable-with-evidence` — không cần làm; evidence trong cột "Fix".
- `blocked-with-reason` — không làm được trong phiên; lý do trong "Fix".

**Ghi chú phân loại (2026-07-07 post-deploy)**: Không dùng `fixed-and-tested` cho migration/RPC prod đã áp nhưng chưa có bằng chứng negative cross-tenant (VD Org A gửi camera Org B → rejected count > 0). "Chạy thành công trên prod" ≠ "đã test cả negative path".

## Findings

| ID | Finding | Verified | Root cause | Fix | Tests | Commit | Status |
|---|---|---|---|---|---|---|---|
| CRIT-3A | Agent thiếu top-level `unhandledRejection`/`uncaughtException`; nhiều `void promise` không `.catch` (contract Node) | 0 handler top-level; 10+ `void promise` fire-and-forget (index.ts boot chain + timers + shutdown, recording-lifecycle respawn/long-retry/reportStatus, segment-index flush, segment-watcher poll) | Node 24 default crash; agent .exe không có handler + không có `.catch` → chết im lặng ở kho | `src/fatal.ts` (installFatalHandlers idempotent + counter 20/60s, swallow(promise, tag)); import + wire vào index/lifecycle/segment-index/segment-watcher | `tests/fatal.test.ts` 4 case (idempotent, catch reject + tag, không leak lên unhandledRejection, non-Error reason) | 7239fb1 | fixed-and-tested |
| CRIT-3B | Windows Service restart sau `process.exit(1)` (installer ssInstall) | `installFatalHandlers` set exit code 1 trên `uncaughtException` + threshold breach — mục tiêu là SCM restart | Contract: exit code khác 0 = SCM restart theo policy service. Chưa verify SCM policy thực tế của `warehouse-agent` service (recovery flags: restart/reset/backoff) | Không đổi installer trong Vòng A; cần review `warehouse-agent/installer/*.iss` + `sc failure` config trong B2 | Contract Node đã test unit. Windows Service behavior thật CHƯA test | 7239fb1 | fixed-needs-environment-validation |
| CRIT-4 | Agent PUT bucket không timeout, có thể treo pipeline | STEP 6 `fetch(signedUrl, method:PUT)` không AbortController → treo vô hạn nếu Supabase POP hang socket | fetch mặc định không timeout; upload path không bọc AbortController | `src/upload.ts` uploadWithTimeout: timeout = min/max/base+perMb, retry EXP backoff cho timeout/network/5xx, fail-fast 4xx, external abort. index.ts STEP 6 dùng helper | `tests/upload.test.ts` 7 case (hang→timeout không kẹt, 401 fail-fast, 500 retry, external abort, size-scaled timeout, secret không rò vào error message) | 46d2c1e | fixed-and-tested |
| HIGH-7 | POST/DELETE `/platform/impersonate` không ghi `platform_audit_log` | Route hoàn toàn không insert `platform_audit_log`, org lookup không destruct `.error` | Thiếu audit + Supabase SDK không throw khi RLS/DB lỗi | audit-core.ts (pure, testable) + audit.ts (server-only wrapper); POST audit start fail-closed (503), DELETE audit stop fail-open (thoát vẫn cho), DELETE yêu cầu requirePlatformRole | tests/platform-audit-core.test.ts 5 case (row shape + null default + writer ok/err + không rò metadata log) | 5e04fcc | fixed-and-tested |
| HIGH-8 | `DELETE /station-devices/[id]` UPDATE assignment không filter org | `station_device_assignments` UPDATE chạy TRƯỚC ownership check, không có `.eq("organization_id")` | Thiếu verify + defense-in-depth khi cascade | Verify device ownership TRƯỚC (SELECT theo id+org, 404 nếu miss), assignment UPDATE thêm `.eq("organization_id")`, destruct `.error` cho SELECT + UPDATE, return 500 nếu DB fail | `scripts/check-tenant-scoped-writes.mjs` grep-guard 3 pattern regex chặt; test negative: fail đúng khi remove `.eq("organization_id")` khỏi assignment, pass lại khi restore | ad5aefa | fixed-and-tested |
| HIGH-9 | `PATCH /staff/[id]` INSERT `staff_warehouse_assignments` không verify warehouse_id thuộc org | INSERT dùng warehouse_id thẳng từ body; SELECT/UPDATE/INSERT assignment không có org filter; nhiều `.error` bị nuốt | Trust client input + thiếu defense-in-depth | Verify warehouse_ids SELECT eq(org).in(id) → reject 400 nếu có 1 sai (không echo IDs); dedupe input; assignment SELECT/UPDATE/INSERT thêm `.eq("organization_id")`; destruct `.error` cho warehouse lookup + current SELECT + remove/insert/primary UPDATE + user_profiles sync (best-effort log) | scripts/check-tenant-scoped-writes.mjs thêm 5 rule (warehouse lookup, insert row map org, 3 UPDATE chain có org) — all pass | e1d7a0b | fixed-and-tested |
| HIGH-10 | `warehouse/agents/[id]` UPDATE/DELETE/reset-secret thiếu `.eq(organization_id)` defense-in-depth | 2 route tenant-facing: DELETE `[id]/route.ts` + POST `[id]/reset-secret/route.ts` (route sau = UPDATE column secret). Grep `PATCH\|PUT` trong `src/app/api/warehouse/agents/` → **0 route PATCH/PUT**. UPDATE `warehouse_agents` khác chỉ có: 6 route agent HMAC self-update `last_seen_at` (agent-side, verify org qua HMAC secret match by `code`) + 2 route dashboard telemetry — không phải "UPDATE tenant-facing agent CRUD". Không có PATCH bổ sung phải fix. | Trust JS check `.organization_id !== ctx`, không dùng query layer làm second lớp bảo vệ | SELECT verify chuyển sang `.eq("id").eq("organization_id")` ở query; destruct `.error` → 500; DELETE + UPDATE thêm `.eq("organization_id")` defense-in-depth; audit reset_secret sẵn có | scripts/check-tenant-scoped-writes.mjs thêm 4 rule (SELECT + DELETE/UPDATE chain org) — all 4 PASS. Grep evidence: `Grep pattern="export async function (PATCH\|PUT\|POST\|DELETE\|GET)" path=src/app/api/warehouse/agents` → chỉ DELETE + GET + POST + POST reset-secret | e5d490b | fixed-and-tested |
| HIGH-11 | `updateCamera` không invalidate `codec_detected` khi đổi IP/RTSP/user/pass | Không reset snapshot codec cũ khi field kết nối đổi | Trạng thái probe là snapshot at-time, không tự invalidate → stream mới + codec cũ = clip failed | codec-invalidation.ts (pure detect + patch); updateCamera merge patch atomic vào UPDATE cho ip/rtsp_port/rtsp_path/username/password; best-effort enqueue probe_codec sau UPDATE (agent active theo last_seen_at); enqueue fail chỉ log không throw | tests/codec-invalidation.test.ts 7 case (name only, ip, password null, all 5, undefined không tính, extra field bỏ qua, patch shape) | 65f91b9 | fixed-and-tested |
| HIGH-14 | Cron secret compare `===` không timing-safe | 2 route (`/api/admin/cleanup-expired-clips`, `/api/cron/cleanup-clips`) so sánh `===`/`!==` | JS string compare dừng ở byte đầu khác → timing leak prefix | `src/lib/secure-compare.ts` secureCompare + verifyBearerSecret dùng `crypto.timingSafeEqual`; length lệch trả false + dummy compare san timing; xử null/empty; dùng ở cả 2 route | tests/secure-compare.test.ts 11 case (match, byte đầu/cuối, length lệch, null/undefined/empty, unicode, Bearer prefix, không throw dù length lệch nhiều) | 665ea12 | fixed-and-tested |
| HIGH-15A | Supabase write bỏ qua `.error` — các vị trí critical đã nêu trong review | audit.ts try/catch swallow; watch route insert failed clip không destruct → loop; platform/admins/*.ts try/catch swallow; camera service.ts updateCameraTestResult không destruct | Supabase SDK trả `{data,error}`, không throw khi RLS/constraint reject → try/catch chỉ bắt network | audit.ts destruct `{error}` + log không log metadata; watch route insert failed clip destruct → nếu fail trả state=failed `[reconcile-write-failed]` chặn loop; platform/admins/*.ts thay try/catch bằng logPlatformAudit; updateCameraTestResult destruct log console (best-effort). Staff route + station-devices route + agents route đã fix trong HIGH-7/8/9/10. | scripts/check-audit-destruct-error.mjs 5 rule chốt 5 file — test negative fail 3 check khi revert audit.ts về try/catch, pass khi restore | 9609d3a | fixed-and-tested |
| HIGH-15B | Supabase write bỏ qua `.error` — 28 write còn lại (17 file) chưa được phân loại + fix | scripts/inventory-supabase-writes.mjs quét toàn `src/` phát hiện 28 write không destruct `{error}`. Phân bố sơ bộ: telemetry (last_seen_at) ~9 write; business-critical (command result, scans, packing-stations, station-device-assignments) ~14 write; audit-critical (signup_attempts) ~2 write; recording-service destructive delete ~3 write. | Chưa fix — theo yêu cầu Vòng A "chỉ sửa vị trí đã nêu" | Chưa fix. Đưa vào B1 (business-critical liên quan command result / poll / scans / RPC enqueue) + Vòng C (telemetry + best-effort) | Inventory script chạy: 28 write, 17 file. Danh sách đầy đủ xem output `node scripts/inventory-supabase-writes.mjs` | — | verified |
| RECONCILE-20260704160000 | 2 migration file cùng version `20260704160000` — `schema_migrations` chỉ ghi row cho file B, file A ghi vào row `20260704081706` (drift lịch sử) | MCP query prod: 2 row schema_migrations version+name lệch nhau; effect cả 2 file đã áp đúng (5 col dropped, 3 index tồn tại đúng shape) | Supabase CLI legacy behavior: cùng version → 1 row với name last alphabet | Migration mới `20260707140000_reconcile_duplicate_20260704160000.sql` idempotent re-apply (IF EXISTS + IF NOT EXISTS + `DO $$` postcondition guard). Comment cảnh báo trong 2 file gốc. `scripts/check-migration-versions.mjs` whitelist exact filename set. | Applied prod 2026-07-07; postcondition `DO $$` guard pass (không RAISE); MCP verify 4 row `20260707140000-140300` sau khi user paste INSERT tay | 9e147c2, applied prod SQL Editor | fixed-and-production-validated |
| CRIT-5 | `apply_camera_probes(jsonb)` v1 SECURITY DEFINER + PUBLIC EXECUTE grant → anon/authenticated tampering `cameras.last_probe_*` cross-tenant | MCP prod 2026-07-07 preflight: `apply_camera_probes` anon=true, authn=true, pub_explicit=true. `enqueue_clip_generation` đã fail-closed sẵn. | RPC không có `p_organization_id` filter + Supabase default grant EXECUTE cho PUBLIC | Migration `20260707140100`: (a) REVOKE anon/authenticated/PUBLIC khỏi v1, giữ service_role backward-compat; (b) CREATE `apply_camera_probes_v2(p_organization_id uuid, p_probes jsonb)` với tenant filter `WHERE c.organization_id = p_organization_id`, return `jsonb{requested, updated, rejected}`; (c) `search_path = public, pg_temp`; (d) grant chỉ service_role. Route camera-probe update dùng v2, log rejected structured không leak camera_ids, RPC error → 500. | Positive runtime prod 2026-07-07: 3/3 camera có `last_probe_at` update recent qua route v2. Negative cross-tenant (Org A payload camera Org B) chưa chạy vì hệ hiện chỉ 1 org. `supabase/verify/b1_1_verify.sql` section 5.1-5.7 prepared, cần disposable branch để chạy. | 8ca19eb, applied prod SQL Editor | fixed-and-production-validated-with-negative-tests-pending |
| CRIT-6 | `enqueue_clip_generation` chỉ verify packing_event thuộc org, KHÔNG verify camera + agent → có thể INSERT lai tenant (agent Org C nhận job clip_id Org A trên camera Org B) | MCP prod 2026-07-07: schema pg_proc + comment RPC gốc không có 2 verify PERFORM 1 cho cameras + warehouse_agents | Guard chưa đủ 3 tầng org (chỉ có 1) | Migration `20260707140200` CREATE OR REPLACE cùng signature, thêm 2 PERFORM 1 FROM cameras/warehouse_agents WHERE id AND organization_id + RAISE explicit `enqueue_camera_not_in_org` / `enqueue_agent_not_in_org` (ERRCODE P0001). Không đổi output. | Function đã deploy prod (verify Section 3: description chứa "CRIT-6 verify"). Chưa có traffic cross-tenant thật để trigger RAISE positive negative (1 org duy nhất). Section 6.2-6.4 verify script prepared cho disposable branch. Concurrent 6.5 = design only. | 71869c8, applied prod SQL Editor | fixed-and-production-applied-needs-negative-path-validation |
| B1.1a-ACL-CLOSURE | v1+v2+enqueue có thể có PUBLIC/anon/authenticated EXECUTE default (Supabase legacy) — REVOKE riêng anon+authenticated không đóng leak nếu PUBLIC còn | MCP prod 2026-07-07: v1 `pub_explicit=true`, `anon=true`, `authn=true`. Migration B1.1 dòng REVOKE riêng không đủ vì PUBLIC là root implicit. | Postgres default grant PUBLIC EXECUTE cho function trong schema public + Supabase không set default privileges khác | Migration `20260707140300`: (a) REVOKE ALL FROM PUBLIC/anon/authenticated trên 3 function idempotent; (b) GRANT service_role; (c) `DO $$` postcondition guard qua `has_function_privilege` + `aclexplode` PUBLIC grantee=0 = 0. Route camera-probe: RPC error → 500 explicit, log rejected structured không log camera_ids raw, response generic không tiết lộ chi tiết rejected. `scripts/check-apply-camera-probes-legacy.mjs` chặn caller mới dùng v1. Ngày drop v1 dự kiến 2026-07-21. `supabase/verify/b1_1_verify.sql` rewrite Section 5-6 bọc `BEGIN...ROLLBACK` trong comment block + namespace `b1_1_test_*` + concurrency 6.5 note "verification design only". | MCP prod 2026-07-07 post-apply: `has_function_privilege('anon', 3 fn, 'EXECUTE') = false`; `has_function_privilege('authenticated', ...) = false`; `aclexplode PUBLIC grantee=0 = false`. Cả 3 function `pub_explicit=false, anon=false, authn=false, svc=true`. | fd571f5, applied prod SQL Editor | fixed-and-production-validated |
| NEW-3 | Warehouse relational invariant: RPC không thể verify "camera+agent+packing_event cùng warehouse" | MCP prod 2026-07-07: `cameras` KHÔNG có `warehouse_id` column; `warehouse_agents` KHÔNG có `warehouse_id` column; không có bảng many-to-many `warehouse_agent_warehouses`. Chỉ `packing_events.warehouse_id` (nullable, SET NULL). | Schema V0 dump 1-warehouse/org assumption; không design cho multi-warehouse per org | Chờ product decision (a) mở multi-warehouse per org — cần thêm cột + FK + backfill trong Vòng B/C, hoặc (b) 1-warehouse/org mãi mãi — đóng vĩnh viễn. Không bịa constraint. | — | — | blocked-with-reason |

## Ghi chú scope

- Chỉ Vòng A. Các CRIT/HIGH khóa (khóa phiên): CRIT-1 recorder Windows, CRIT-2 reaper redesign, CRIT-5/6 RPC migration, HIGH-16/17 migration duplicate + rollback, HIGH-18 HMAC nonce, envelope encrypt agent secret.
- Không sửa/xóa route deprecated, không xóa dead code (chỉ inventory nếu phát sinh).
- Không chạy migration lên bất kỳ DB nào.
- Untracked file (`query`, `supabase/rollback/`) giữ nguyên.

## HIGH-15B — Phân loại 28 write chờ Vòng B/C

**Business-critical (Vòng B1)** — write mà fail phải return error cho caller, không silent:

| File | Line | Method | Ghi chú |
|---|---|---|---|
| `agent/command-result/route.ts` | 163, 175, 217 | update | Kết quả job cut_clip / probe / test_camera — silent fail = trạng thái clip lệch |
| `agent/poll-commands/route.ts` | 175 | update | State transition command (taken/failed) |
| `cameras/[id]/recording/restart/route.ts` | 123 | update | Restart session — cần biết fail |
| `cameras/[id]/recording/start/route.ts` | 122 | update | Start session |
| `packing-stations/[id]/route.ts` | 111 | update | Trạng thái packing station |
| `station-device-assignments/route.ts` | 122, 158 | update | Assignment change |
| `warehouse/scans/route.ts` | 410 | update | Scan record |
| `camera/recording-service.ts` | 177, 264, 353, 516 | update+3 delete | Destructive delete recording files |
| `qr.ts` | 47 | update | QR revoke |
| `warehouse/staff-qr.ts` | 104 | update | last_used_at (business-tracked) |

**Audit-critical (Vòng B1)** — write mà fail phải log/return error, không silent:

| File | Line | Method |
|---|---|---|
| `signup/route.ts` | 199 | insert (signup_attempts) |
| `signup/route.ts` | 345 | update (succeeded flag) |

**Telemetry / best-effort (Vòng C)** — heartbeat `last_seen_at`, fail log warning, không outage:

| File | Line | Method |
|---|---|---|
| `agent/camera-probe/route.ts` | 209 | last_seen_at |
| `agent/poll-commands/route.ts` | 155 | last_seen_at |
| `agent/recording-credentials/route.ts` | 160 | last_seen_at |
| `warehouse/heartbeat/route.ts` | 79 | last_seen_at + time_drift |
| `warehouse/scans/route.ts` | 400 | last_seen_at |
| `warehouse/discovery/route.ts` | 144, 158, 186 | connection_status + last_seen_at |

**False-positive (inventory script bắt nhầm — không phải Supabase)**:
- `src/lib/camera/crypto.ts:58` — `decipher.update()` (Node crypto)
- `src/lib/platform/internal-headers-core.ts:26` — `createHmac(...).update(...)` (Node crypto)

Tổng: 28 write thật. Đúng scope B1 = 14 business + 2 audit = 16 write. Còn 12 telemetry đưa Vòng C.
