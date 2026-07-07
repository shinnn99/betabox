# Betacom Beta Cam

Hệ ghi hình đóng hàng tại kho + cắt video bằng chứng theo mã đơn + SaaS đa tenant.

## Kiến trúc

Hai layer chính:

- **Cloud** (Next.js 16 trên Vercel):
  - Dashboard admin: `src/app/dashboard/`
  - Platform-level (SaaS operator): `src/app/platform/`
  - API routes: `src/app/api/`
  - Supabase (Postgres + Storage + Auth): 60+ migration ở `supabase/migrations/`

- **Warehouse Agent** (Node.js đóng gói `.exe` cho Windows kho):
  - Chạy 24/7 trong LAN kho, kết nối RTSP camera.
  - Đóng gói qua `@yao-pkg/pkg` + installer Inno Setup.
  - Cấu hình + docs cài đặt: `warehouse-agent/`

## Setup local

Yêu cầu: Node 22+, pnpm, mkcert cert cho HTTPS local.

```powershell
# 1. Deps
pnpm install

# 2. Env
copy .env.local.example .env.local
# Điền: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ... (xem `.env.local` đã có)

# 3. mkcert cert (Next 16 dev cần HTTPS + allowedDevOrigins)
# xem `certs/README.md`

# 4. Chạy dev
pnpm dev
# HTTPS: https://localhost:3000
```

## Migration Supabase

Apply migration mới qua CLI Supabase:

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

Hoặc paste SQL body vào Supabase Dashboard → SQL Editor (thủ công cho migration nhỏ).

CI guard `scripts/check-migration-versions.mjs` chặn 2 file cùng version.

## Warehouse Agent

Cài đặt: xem `warehouse-agent/CACH-CAI-KHACH.md`.

Build:

```powershell
cd warehouse-agent
pnpm run build:exe        # → dist-exe/betacom-agent.exe
& "C:\Program Files (x86)\Inno Setup 6\iscc.exe" installer/betacom-agent.iss
# → dist-installer/BetacomAgentSetup-v<version>.exe
```

## Test

```powershell
# App
node --loader ./scripts/node-path-alias-loader.mjs --experimental-strip-types --test tests/*.test.ts

# Agent
cd warehouse-agent && pnpm exec tsx --test tests/*.test.ts

# CI guards
node scripts/check-migration-versions.mjs
node scripts/check-tenant-scoped-writes.mjs
node scripts/check-audit-destruct-error.mjs
node scripts/check-apply-camera-probes-legacy.mjs
```

## Security boundaries

- **Tenant isolation**: 3 lớp — route guard, query filter, RPC verify.
- **HMAC agent**: `x-agent-code/timestamp/signature`, skew ±5 phút. V2 với nonce
  đã implement (B1.3), chờ agent v0.4 rollout.
- **Platform-admin impersonation**: audit-critical fail-closed, snapshot bất biến.
- **Recording**: reaper flip `connection_lost` khi mất WAN (không stopped),
  poll rescue kéo về `recording` khi agent reconnect.

Chi tiết đã đóng: `docs/remediation-2026-07.md`.

## Docs khác

- `docs/remediation-2026-07.md` — trạng thái finding, 4-tier evidence.
- `docs/remediation-2026-07-b0.md` — B0 discovery + threat model.
- `docs/remediation-2026-07-b1-1a.md` — B1.1a ACL closure + warehouse relation.
- `warehouse-agent/CACH-CAI-KHACH.md` — hướng dẫn cài agent cho khách.
- `supabase/verify/` — verification scripts cho các migration lớn.
