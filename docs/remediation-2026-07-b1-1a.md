# B1.1a — Security closure (2026-07-07)

Branch: `fix/remediation-round-b`.
Cấp trên: B1.1 vẫn giữ, B1.1a bổ sung ACL closure + evidence + safety verify script.

## 1. ACL matrix trước patch (MCP prod, 2026-07-07)

Query: `has_function_privilege(role, oid, 'EXECUTE')` + `aclexplode(proacl)` cho PUBLIC (grantee=0).

| Function | PUBLIC | anon | authenticated | service_role | postgres |
|---|---|---|---|---|---|
| `apply_camera_probes(jsonb)` v1 | **✅ has EXECUTE** | ✅ | ✅ | ✅ | ✅ (owner) |
| `apply_camera_probes_v2(...)` | — chưa tồn tại — |
| `enqueue_clip_generation(...)` | ❌ | ❌ | ❌ | ✅ | ✅ |

**Bằng chứng leak thực sự**: `apply_camera_probes` v1 có PUBLIC EXECUTE — anon/authenticated hưởng quyền qua PUBLIC. Migration B1.1 `20260707140100` chỉ REVOKE FROM anon+authenticated+PUBLIC (thứ tự) nhưng khi apply lên môi trường mà v1 chưa có REVOKE FROM PUBLIC lần nào, PUBLIC vẫn giữ default EXECUTE grant implicit.

`enqueue_clip_generation` đã fail-closed đúng chuẩn từ migration `20260706100100` — không cần fix ACL, chỉ thêm idempotent guard.

## 2. ACL matrix kỳ vọng sau migration B1.1a `20260707140300`

| Function | PUBLIC | anon | authenticated | service_role |
|---|---|---|---|---|
| `apply_camera_probes(jsonb)` v1 | ❌ | ❌ | ❌ | ✅ (backward-compat window) |
| `apply_camera_probes_v2(...)` | ❌ | ❌ | ❌ | ✅ |
| `enqueue_clip_generation(...)` | ❌ | ❌ | ❌ | ✅ |

Migration `20260707140300`:
- REVOKE ALL FROM PUBLIC/anon/authenticated cho cả 3 function (idempotent).
- GRANT EXECUTE TO service_role (giữ cho backward-compat + CREATE OR REPLACE tương lai không tự động mở lại).
- DO $$ postcondition guard: sau apply, `has_function_privilege('anon'|'authenticated', ...)` = false và PUBLIC EXECUTE grant explicit = 0.

## 3. Caller — Supabase client role

| Route | File | Client | Role thật |
|---|---|---|---|
| `POST /api/agent/camera-probe` | `src/app/api/agent/camera-probe/route.ts:2, 86` | `createAdminClient()` | `service_role` (SUPABASE_SERVICE_ROLE_KEY) |

Verified bằng grep:
```
src/app/api/agent/camera-probe/route.ts:2:import { createAdminClient } from "@/lib/supabase/admin";
src/app/api/agent/camera-probe/route.ts:86:  const admin = createAdminClient();
```

`createAdminClient` trong `src/lib/supabase/admin.ts` khởi tạo với `SUPABASE_SERVICE_ROLE_KEY` — bypass RLS. REVOKE PUBLIC/anon/authenticated KHÔNG phá caller.

## 4. Warehouse relation evidence

MCP prod query (2026-07-07):

| Table | `warehouse_id` column | FK to `warehouses.id` | Nullable | ON DELETE |
|---|---|---|---|---|
| `packing_events` | ✅ | ✅ | YES | SET NULL |
| `cameras` | ❌ | — | — | — |
| `warehouse_agents` | ❌ | — | — | — |
| `packing_stations` | ✅ | ✅ | NO | CASCADE |
| `staff_qr_scan_results` | ✅ | ✅ | YES | SET NULL |
| `staff_warehouse_assignments` | ✅ | ✅ | NO | CASCADE |
| `staff_work_sessions` | ✅ | ✅ | NO | RESTRICT |
| Bảng many-to-many `warehouse_agent_warehouses`? | ❌ tables listed: `warehouses`, `warehouse_agents` |

**Kết luận CRIT-6 warehouse relation part**:

Schema hiện tại KHÔNG hỗ trợ invariant "camera+agent+packing_event cùng warehouse":
- `cameras` không có `warehouse_id` → camera thuộc org, không thuộc warehouse cụ thể.
- `warehouse_agents` không có `warehouse_id` → agent thuộc org, cũng không thuộc warehouse.
- Không có bảng many-to-many.

Theo prompt B1.1a mục 4: "Nếu schema không đủ để chứng minh quan hệ → không bịa constraint, ghi `blocked-with-reason`, tạo finding riêng cho missing relational invariant."

**Finding mới trong remediation**: `NEW-3` (WAREHOUSE-RELATION-MISSING).

CRIT-6 tenant isolation (event/camera/agent cùng org) = `fixed-needs-environment-validation`. Warehouse relation = `blocked-with-reason`.

## 5. Files changed

- `supabase/migrations/20260707140300_b1_1a_close_public_execute_on_rpc.sql` — mới.
- `scripts/check-apply-camera-probes-legacy.mjs` — mới, chặn caller mới dùng v1.
- `src/app/api/agent/camera-probe/route.ts` — RPC error → 500, log rejected structured không leak camera_ids.
- `supabase/verify/b1_1_verify.sql` — rewrite: bọc BEGIN/ROLLBACK, namespace `b1_1_test_`, concurrency 6.5 note "verification design only".

## 6. Static checks / tests

| Check | Kết quả |
|---|---|
| `pnpm exec tsc --noEmit` | PASS (0 error) |
| `node scripts/check-migration-versions.mjs` | PASS (55 versions, 0 new dup) |
| `node scripts/check-apply-camera-probes-legacy.mjs` | PASS (0 caller v1 in src/) — test negative: FAIL đúng khi thêm dummy caller |
| `node scripts/check-tenant-scoped-writes.mjs` | PASS (4 rule) |
| `node scripts/check-audit-destruct-error.mjs` | PASS (5 rule) |

## 7. Typecheck

App + agent: PASS.

## 8. Commit hash

Sẽ commit sau khi review file.

## 9. Git status

Sẽ hiển thị sau commit.

## 10. Cần Supabase branch validation

- Apply migration `20260707140000`, `20260707140100`, `20260707140200`, `20260707140300` lên Supabase branch/local.
- Chạy Section 1-4 read-only trên đó, verify ACL matrix + shape/warehouse relation match kỳ vọng.
- Chạy Section 5-6 destructive (uncomment + BEGIN/ROLLBACK).
- Verify NGÀY DROP v1: 2026-07-21 nếu `check-apply-camera-probes-legacy.mjs` vẫn PASS.

## 11. Trạng thái mới trong remediation

- Reconciliation migration `20260707140000`: `fixed-needs-environment-validation`.
- CRIT-5 (apply_camera_probes_v2 + ACL closure): `fixed-needs-environment-validation`.
- CRIT-6 tenant isolation (event+camera+agent cùng org): `fixed-needs-environment-validation`.
- CRIT-6 warehouse relation: `blocked-with-reason` — schema hiện tại không hỗ trợ. → Finding mới NEW-3.

### Finding mới NEW-3: warehouse relation missing invariant

| ID | Finding | Verified | Root cause | Fix | Tests | Commit | Status |
|---|---|---|---|---|---|---|---|
| NEW-3 | Cameras + warehouse_agents không có `warehouse_id` → RPC không thể verify event+camera+agent cùng warehouse | MCP query 2026-07-07: chỉ packing_events có warehouse_id, 2 bảng còn lại không có FK to warehouses | Schema V0 dump 1-warehouse/org assumption | Cần design: (a) thêm `cameras.warehouse_id` + `warehouse_agents.warehouse_id` khi mở đa-warehouse; (b) hoặc bảng many-to-many `warehouse_agent_warehouses` nếu agent phục vụ nhiều warehouse. Chờ product decision. | — | — | blocked-with-reason |

Đây là finding future khi mở multi-warehouse per org. Betacom hiện 1 warehouse/org nên không phá thực tế; chỉ khi khách thứ 2 có cấu hình 2+ warehouse mới cần fix.
