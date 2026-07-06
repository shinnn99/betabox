# B0 — Read-only verification (2026-07-07)

Branch: `fix/remediation-round-b` (từ `main` `dbb9f8e`).

Không thay đổi behavior production. Chỉ SELECT MCP + đọc code + tạo CI guard.

## 1. Migration environment matrix — duplicate `20260704160000`

### Files trên đĩa

| File | Nội dung |
|---|---|
| `20260704160000_drop_organizations_metadata_columns.sql` | `ALTER TABLE organizations DROP COLUMN IF EXISTS {legal_name,tax_code,phone,email,address}` × 5, có `DO $$` guard verify count=0 |
| `20260704160000_n1_indexes_for_dashboard_live_queries.sql` | `CREATE INDEX IF NOT EXISTS` 3 index: `idx_packing_events_org_business_date`, `idx_packing_events_org_scanned_at`, `idx_warehouse_scan_raw_events_org_received_at` |

### MCP query prod (read-only)

| Query | Kết quả |
|---|---|
| `SELECT * FROM supabase_migrations.schema_migrations WHERE version = '20260704160000'` | **1 row**, `name = 'n1_indexes_for_dashboard_live_queries'` |
| 5 cột `organizations.{legal_name, tax_code, phone, email, address}` còn tồn tại? | **0 cột còn** (đã drop) |
| 3 index `idx_packing_events_org_business_date` / `idx_packing_events_org_scanned_at` / `idx_warehouse_scan_raw_events_org_received_at` tồn tại? | **3/3 tồn tại** |

### Matrix

| Environment | Version row exists | File A effect (5 col drop) | File B effect (3 index) | Kết luận |
|---|---|---|---|---|
| prod | ✅ 1 row, name=file B | ✅ đã áp | ✅ đã áp | **Cả 2 file đã chạy trên prod; nhưng chỉ file B ghi tên vào `schema_migrations`. Không có dev/staging Supabase riêng theo repo — chỉ 1 environment shared.** |

### Chiến lược (chưa thực thi — B1)

**Không rename** cả 2 file lịch sử — sẽ tạo drift `schema_migrations` (CLI thấy version+name không match → coi như migration mới → thử chạy lại; File A nếu chạy lại vẫn OK do `IF EXISTS` + guard, nhưng CLI ≥ v2.90 sẽ báo diff).

**Không tự sửa `supabase_migrations.schema_migrations`** (theo rule prompt).

**Kế hoạch B1**: Tạo migration reconciliation mới version `20260707XXXXXX_reconcile_20260704160000_dup.sql`:
- Chỉ chứa comment ghi rõ situation + `DO $$` idempotent re-guards (ALTER TABLE ... IF EXISTS + CREATE INDEX IF NOT EXISTS) để clone-from-prod hoặc fresh dev/staging apply đủ cả 2 tác dụng nếu drift.
- Không phá trạng thái prod hiện tại.

### CI guard (đã tạo B0)

`scripts/check-migration-versions.mjs`:
- Group filename theo 14-digit version, fail nếu > 1 file/version.
- Whitelist `20260704160000` (KNOWN historic — log warn không fail).
- Test negative: thêm file duplicate mới → exit 1 với message chi tiết.

## 2. HIGH-10 PATCH verify — reconfirmed

Grep `Grep pattern="export async function (PATCH|PUT|POST|DELETE|GET)" path=src/app/api/warehouse/agents`:

```
[id]/route.ts:20:                    export async function DELETE
route.ts:18:                         export async function GET
route.ts:49:                         export async function POST
[id]/reset-secret/route.ts:25:       export async function POST
```

**Không có PATCH/PUT route tenant-facing** cho `warehouse_agents`. "UPDATE" trong report HIGH-10 gốc = UPDATE column `secret` trong `POST /reset-secret/route.ts` (đã fix). Còn UPDATE agent HMAC self-update `last_seen_at` × 6 route là scope HIGH-15B (telemetry, không phải tenant-facing CRUD).

Đã cập nhật remediation-2026-07.md với evidence + không đổi status HIGH-10.

## 3. Schema `warehouse_agents.secret` + auth flow

### Schema hiện tại (MCP query)

```
column_name        | data_type                | nullable | default
-------------------|--------------------------|----------|--------
id                 | uuid                     | NO       | gen_random_uuid()
organization_id    | uuid                     | NO       | -
code               | text                     | NO       | -
name               | text                     | NO       | -
secret             | text                     | NO       | -        ← PLAINTEXT
status             | text                     | NO       | 'active'
last_seen_at       | timestamptz              | YES      | -
created_at         | timestamptz              | NO       | now()
updated_at         | timestamptz              | NO       | now()
last_discovered_scanners | jsonb              | YES      | -
last_discovered_at | timestamptz              | YES      | -
time_drift_seconds | integer                  | YES      | -
```

**KHÔNG có** cột `secret_ciphertext`, `secret_iv`, `secret_tag`, `secret_kek_version`. Phải thêm trong Phase 1 B3.

### Số row hiện tại

```
total_agents=1, active=1, non_active=0
oldest=2026-06-26, newest=2026-06-26
```

**1 agent duy nhất** (kho nội bộ Betacom). Phase 4 per-agent rotation = 1 agent → risk migration cực thấp, không thực sự cần rollout dài.

### Auth flow cần plaintext

`src/lib/warehouse/agent-auth.ts::verifyAgentSignature`:
```
createHmac("sha256", secret).update(message).digest("hex")
```

**HMAC yêu cầu server có key nguyên vẹn** để tính lại signature. Không thể dùng bcrypt/argon2 "hash-only" như password login. **Phải** dùng envelope encryption:
- DB: `secret_ciphertext bytea NOT NULL`, `secret_iv bytea NOT NULL`, `secret_tag bytea NOT NULL`, `secret_kek_version int NOT NULL`.
- Runtime: decrypt bằng KEK_V1 (Vercel env) → gọi `createHmac(plaintext, ...)`.

14 file server-side đọc `agent.secret`:
- `agent/{clip-upload-complete,clip-cut-result,clip-upload-url,command-result,recording-credentials,camera-probe,poll-commands,recording-status,recording-files/known,recording-files}/route.ts` (10)
- `warehouse/{heartbeat,discovery,scans}/route.ts` (3)
- `lib/warehouse/agent-auth.ts` (1, dùng qua param)

**Chiến lược Phase 2 dual-read**:
- Nếu row có `secret_ciphertext` NOT NULL → decrypt.
- Else → dùng plaintext `secret` legacy.
- Wrap thành helper `resolveAgentSecret(row)` — 14 file gọi qua helper duy nhất.

### Threat model (draft cho B3)

1. **DB dump đơn độc** (SQL injection, backup rò): kẻ tấn công có `warehouse_agents.secret` plaintext → giả mọi agent → cross-tenant. Envelope encryption **NGĂN** scenario này (không có KEK).
2. **Vercel runtime compromise**: kẻ tấn công có KEK từ env → decrypt tất cả secret. Envelope encryption **KHÔNG NGĂN** — cần KMS thật (out-of-scope B3).
3. **Agent `.env` rò** (máy kho bị chiếm): chỉ lấy 1 agent secret. Envelope encryption **KHÔNG THAY ĐỔI** — giữ nguyên rủi ro.
4. **Log rò**: bất kỳ path decrypt / verify không được `console.log` plaintext hoặc partial ciphertext.

### Cấu trúc `KeyProvider` (draft B3)

```
interface KeyProvider {
  version: number; // 1
  encrypt(plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer };
  decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): Buffer;
}
```

Impl B3 phase 1: `EnvKekProvider` đọc `AGENT_SECRET_KEK_V1` từ env (32 random bytes base64), AES-256-GCM.

Impl future: `KmsKeyProvider` (AWS KMS / GCP KMS) — thay 1 chỗ, không đổi caller.

## 4. Windows service config (installer .iss + NSSM)

File: `warehouse-agent/installer/betacom-agent.iss`, dòng 257-281 `InstallService`.

### NSSM restart policy hiện tại

```
nssm set BetacomAgent AppExit Default Restart
nssm set BetacomAgent AppRestartDelay 5000
```

- `AppExit Default Restart` = bất kỳ exit code khác 0 → NSSM restart sau `AppRestartDelay`.
- `AppRestartDelay 5000` = chờ 5s trước khi restart.
- `AppThrottle` KHÔNG set → NSSM default 1500ms (nếu process crash trong <1.5s sau start, đợi 1.5s trước khi start lại — chống crash loop).
- Graceful stop qua `nssm stop` = gửi SIGTERM → agent handle `SIGTERM` (dòng 1362 index.ts) → exit 0. NSSM stop path không restart.

### Kết luận CRIT-3B

- **Contract**: `installFatalHandlers` set `process.exit(1)` khi `uncaughtException` hoặc `unhandledRejection` threshold breach → NSSM WILL restart theo config.
- **Chưa test thực địa**: chưa có bằng chứng NSSM restart thật sự trong 5s. Cần B2 test:
  - Case 1: `Stop-Process -Force -Name betacom-agent` → NSSM restart trong ~5s.
  - Case 2: trigger uncaughtException (throw trong timer) → agent exit 1 → NSSM restart trong ~5s.
  - Case 3: agent chạy > 90s stable, kill lần 2 → không throttle, restart bình thường.

Không đổi config trong B0 — installer đã ổn contract.

## 5. B0 outputs

### Files changed

- `docs/remediation-2026-07.md` — bookkeeping revised.
- `docs/remediation-2026-07-b0.md` — file này.
- `scripts/check-migration-versions.mjs` — CI guard.

### Tests/checks

- `node scripts/check-migration-versions.mjs`: PASS (KNOWN whitelist, 51 versions checked, 0 new duplicates). Test negative: thêm file duplicate → FAIL đúng.

### MCP queries (read-only, prod)

- `information_schema.columns` for `warehouse_agents`.
- `information_schema.columns` for `organizations` (verify File A effect).
- `pg_indexes` (verify File B effect).
- `supabase_migrations.schema_migrations` where version match.
- `COUNT/MIN/MAX` on `warehouse_agents`.

Không INSERT/UPDATE/DELETE/DDL.

### Commit

Sẽ commit sau khi review docs.

### Git status

- Branch: `fix/remediation-round-b`.
- 1 commit đã có: `df0bbe7` (bookkeeping).
- Sẽ commit `docs/remediation-2026-07-b0.md` + `scripts/check-migration-versions.mjs`.
- Untracked giữ nguyên: `query`, `supabase/rollback/`.

### Remaining rollout / actions cần chạy thật (chờ B1)

- Viết migration reconciliation `20260707XXXXXX_reconcile_20260704160000_dup.sql`.
- Chưa `supabase db push` — chờ lệnh riêng.
- Chưa apply CI job `check-migration-versions.mjs` vào workflow chính — chờ B0 approve.

### Environment limitations

- Không có staging/dev Supabase riêng — chỉ 1 environment shared với prod. Test integration SQL trong B1 phải viết dạng verification query hoặc dùng branch của Supabase (nếu cho phép qua MCP).
- Windows Service behavior chỉ test được trên máy kho thật hoặc VM Windows local.

## 6. Đã CHỐT — không hỏi lại

1. Migration duplicate: có matrix + chiến lược reconciliation, sẽ viết migration mới trong B1.
2. HMAC nonce: dùng Postgres table + cron, không thêm Redis.
3. Audit retention: 365 ngày, actor ON DELETE SET NULL, không cascade, không cron auto-delete cho đến khi retention job test riêng.
4. Deprecated route: giữ đến 2026-08-07, thêm telemetry an toàn.
5. Envelope encryption: Vercel env var KEK_V1, AES-256-GCM, KeyProvider abstraction.
6. Agent secret migration: 5 phase zero-downtime (schema → dual read → new writes encrypted → per-agent rotation → drop plaintext).
