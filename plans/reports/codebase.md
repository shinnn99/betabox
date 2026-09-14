# Bàn giao codebase Betabox

Chào bạn. Đây là thứ tôi muốn có khi mới vào dự án này. Đọc hết mất khoảng 45
phút, và nó sẽ tiết kiệm cho bạn vài tuần.

Tài liệu này trả lời **"làm việc trong repo này thế nào"**. Còn **"từng luồng
chạy ra sao"** thì nằm ở [giaithich.md](giaithich.md) — đọc file này trước, file
kia khi cần tra cứu.

---

## 1. Sản phẩm là gì — mô hình tư duy trong 5 câu

Kho hàng thương mại điện tử bị khách khiếu nại "thiếu hàng / sai hàng". Betabox
ghi hình bàn đóng gói 24/7, và khi có khiếu nại thì **cắt đúng đoạn video của
riêng đơn đó** để đem ra đối chứng.

Vòng đời một đơn hàng trong hệ:

```
Nhân viên quét QR của mình     → mở ca làm việc tại một bàn
Nhân viên quét mã vận đơn      → tạo packing_event, đóng đơn trước đó
Camera ghi liên tục            → segment mp4 60 giây, cả ngày
Quản lý tra mã vận đơn         → hệ cắt clip quanh thời điểm đóng đơn
```

Bán theo mô hình SaaS: nhiều khách (tenant) trên cùng một hệ, cộng thêm một khu
vực riêng cho Betacom (chủ sản phẩm) để quản trị các khách đó.

**Câu quan trọng nhất:** sản phẩm bán ra không phải "video", mà là **bằng
chứng**. Một clip cắt cụt tệ hơn hẳn không có clip — vì nó _được lưu lại làm
bằng chứng chính thức_. Bạn sẽ thấy rất nhiều chỗ trong code từ chối làm việc gì
đó thay vì đoán, và đó là lý do.

---

## 2. Nếu bạn chỉ nhớ được một điều

**Hệ thống có hai nửa chạy ở hai nơi, và nửa trên cloud vĩnh viễn không nhìn
thấy camera.**

|            | Cloud                                         | Warehouse Agent                 |
| ---------- | --------------------------------------------- | ------------------------------- |
| Chạy ở     | VPS (Next.js standalone + systemd)            | Máy Windows đặt trong kho khách |
| Ngôn ngữ   | Next.js 16 / React 19 / TypeScript            | Node 22 đóng gói thành `.exe`   |
| Thấy được  | Postgres, Storage, trình duyệt                | LAN kho, camera RTSP, ổ đĩa     |
| Không thấy | `192.168.x` của khách, không chạy được ffmpeg | Không có gì ngoài kho           |

Mọi việc đụng tới camera — test kết nối, quét LAN, kiểm codec, bật/tắt ghi hình,
cắt clip — **bắt buộc** đi qua hàng đợi lệnh `agent_commands`:

```
Cloud enqueue lệnh  →  Agent poll mỗi 3 giây  →  Agent làm  →  Agent callback
```

Không có đường thứ hai. Khi bạn thấy một route trả `202 + command_id` thay vì
làm việc luôn, đó là lý do.

Đây là ràng buộc thật chứ không phải sở thích: bản đầu tiên của route quét LAN
chạy thẳng trên server Next.js — hoạt động tốt khi cài on-prem, và **luôn báo
"không tìm thấy subnet nội bộ"** ngay khi lên SaaS.

---

## 3. Dựng máy để chạy được

### 3.1 Yêu cầu

- Node 22+, pnpm
- ffmpeg + ffprobe (chỉ cần nếu bạn đụng agent hoặc route `test-draft`)
- Supabase CLI (nếu bạn đụng migration)
- mkcert (cho HTTPS local)

### 3.2 Các bước

```powershell
pnpm install

# .env.local — XEM MỤC 3.3, file mẫu KHÔNG có trong repo
# certs/       — XEM MỤC 3.3, thư mục này cũng KHÔNG có trong repo

pnpm dev        # https://localhost:3000
```

### 3.3 Hai chỗ README nói thiếu — đọc kỹ kẻo mất buổi sáng

**`.env.local.example` không tồn tại trong repo.** README bảo `copy
.env.local.example .env.local` nhưng `.gitignore` chặn `.env*` nên file mẫu chưa
bao giờ được commit. Bạn phải **xin bộ env từ người bàn giao**. Danh sách biến ở
mục 11 bên dưới, nhưng giá trị thì phải xin.

**Thư mục `certs/` cũng không có trong repo** (`.gitignore` chặn `*.pem`). Script
`pnpm dev` chạy `next dev --experimental-https` và trỏ cứng vào
`./certs/localhost-key.pem` + `./certs/localhost.pem`. Bạn phải tự sinh:

```powershell
mkcert -install
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost 127.0.0.1 <IP-LAN-cua-ban>
```

Vì sao bắt buộc HTTPS ở local: Supabase Auth và cookie `Secure` không chạy trên
http, và Next 16 chặn cross-origin dev resource.

**Nếu bạn muốn test trên điện thoại trong cùng Wi-Fi:** IP LAN đang bị hardcode ở
[next.config.ts](next.config.ts) trong `allowedDevOrigins` (hiện là
`192.168.66.160`). Đổi máy hoặc DHCP cấp IP mới thì phải sửa dòng đó **và** sinh
lại cert với IP mới, nếu không điện thoại tải trang được nhưng JS không hydrate
— form bấm không phản ứng gì, không báo lỗi.

### 3.4 Chạy agent ở local

```powershell
cd warehouse-agent
pnpm install
# .env riêng: BACKEND_URL, AGENT_CODE, AGENT_SECRET (tạo agent trên dashboard trước)
pnpm dev
```

Agent cần một bản ghi `warehouse_agents` trên cloud (tạo ở
`/dashboard/agents`) để lấy `code` + `secret`. Không có camera thật thì vẫn chạy
được — nó chỉ log "no desired cameras".

---

## 4. Bản đồ repo — "tôi muốn sửa X thì mở file nào"

Đây là bảng tôi dùng nhiều nhất trong 3 tháng đầu:

| Muốn làm gì                      | Mở file nào                                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thêm/sửa field của camera        | [src/lib/camera/service.ts](src/lib/camera/service.ts) → [src/app/api/cameras/route.ts](src/app/api/cameras/route.ts) → [src/components/devices/CamerasView.tsx](src/components/devices/CamerasView.tsx) |
| Đổi tham số ffmpeg ghi hình      | [warehouse-agent/src/recording.ts](warehouse-agent/src/recording.ts) — hàm `startRecording`                                                                                                              |
| Đổi cách cắt clip                | [warehouse-agent/src/clip-cutter.ts](warehouse-agent/src/clip-cutter.ts)                                                                                                                                 |
| Đổi **độ dài** clip              | [src/lib/order-proof/clip-window.ts](src/lib/order-proof/clip-window.ts) — **chỉ một chỗ này**                                                                                                           |
| Đổi cách chọn segment để cắt     | [src/lib/order-proof/clip-resolver.ts](src/lib/order-proof/clip-resolver.ts)                                                                                                                             |
| Đổi trạng thái online của camera | [src/lib/camera/online-state.ts](src/lib/camera/online-state.ts) — **chỉ một chỗ này**                                                                                                                   |
| Đổi trạng thái ghi hình hiển thị | [src/lib/recording/ui-state.ts](src/lib/recording/ui-state.ts)                                                                                                                                           |
| Sửa luồng xem clip               | [watch/route.ts](src/app/api/order-proof/[pe_id]/watch/route.ts) + [use-watch-clip-state.ts](src/lib/watch/use-watch-clip-state.ts)                                                                      |
| Thêm một loại lệnh agent mới     | [enqueue.ts](src/lib/agent-commands/enqueue.ts) + migration sửa CHECK constraint + `handleCommand` trong [agent/index.ts](warehouse-agent/src/index.ts)                                                  |
| Thêm một endpoint cho agent      | `src/app/api/agent/<tên>/route.ts` + **cả hai** file `agent-api-paths.ts` + chạy test mirror                                                                                                             |
| Thêm quyền mới                   | migration ghi vào `role_permission_matrix` + gọi `requirePermission` trong route                                                                                                                         |
| Thêm mục tự kiểm hạ tầng         | [src/lib/system/checks.ts](src/lib/system/checks.ts) + `CHECK_KEYS` + nhãn ở [status-view.ts](src/lib/system/status-view.ts)                                                                             |
| Thêm trang dashboard             | `src/app/dashboard/<x>/page.tsx` + đăng ký menu ở [src/lib/nav.ts](src/lib/nav.ts)                                                                                                                       |
| Thêm thông báo Lark              | [src/lib/lark/messages.ts](src/lib/lark/messages.ts) + [notify-warehouse-issue.ts](src/lib/lark/notify-warehouse-issue.ts)                                                                               |
| Sửa phân quyền / đa tenant       | [src/lib/supabase/guard.ts](src/lib/supabase/guard.ts)                                                                                                                                                   |
| Sửa impersonation                | [src/proxy.ts](src/proxy.ts) + [src/lib/platform/internal-headers-core.ts](src/lib/platform/internal-headers-core.ts)                                                                                    |

### 4.1 Cấu trúc thư mục

```
src/
  proxy.ts              ← Next 16 gọi "proxy" thay cho "middleware". Chạy TRƯỚC mọi request.
  app/api/              ← ~90 route
    agent/              ← 13 endpoint chỉ agent gọi, xác thực HMAC, KHÔNG có session
    cameras/            ← CRUD + test + discover + recording start/stop/status
    order-proof/        ← clip bằng chứng
    warehouse/          ← nhận quét, heartbeat, live/*
    platform/           ← khu vực của Betacom, không phải của khách
    cron/, system/      ← job nền + tự kiểm
  app/dashboard/        ← UI của khách
  app/platform/         ← UI của Betacom
  lib/
    camera/             ← lõi camera phía cloud
    order-proof/        ← lõi cắt clip phía cloud
    watch/              ← state machine xem clip, signed URL, dọn bucket
    warehouse/          ← HMAC agent, xử lý quét, QR nhân viên, live/*
    system/             ← 9 mục tự kiểm + cảnh báo
    supabase/           ← client + guard phân quyền
warehouse-agent/src/    ← agent chạy trong kho
supabase/migrations/    ← 90+ file, RLS + RPC
tests/                  ← test của cloud
scripts/                ← guard CI + công cụ vận hành
```

### 4.2 Nhận diện file nhanh

- `import "server-only"` ở đầu file → chỉ chạy trên server, **không** import được
  từ client component, và **không** import được từ test.
- File có tên `*-core.ts` (`agent-auth-core`, `audit-core`, `internal-headers-core`)
  → phần thuần đã tách khỏi I/O **để test được**. Sửa logic thì sửa ở đây.
- File `lib/*/` mà không có `server-only` → thường là hàm thuần có test đi kèm.
  Mỗi file như vậy đại diện cho một bug đã từng xảy ra ở production.

---

## 5. Quy ước bắt buộc

### 5.1 Đây KHÔNG phải Next.js bạn từng biết

[AGENTS.md](AGENTS.md) nói thẳng: bản Next 16 này có breaking change so với
những gì bạn quen. **Đọc `node_modules/next/dist/docs/` trước khi viết code
liên quan tới framework.** Vài chỗ khác biệt hay cắn:

- `middleware.ts` → **`proxy.ts`**, hàm export tên `proxy`.
- `params` của route động là **Promise**: `const { id } = await params`.
- Việc chạy sau response dùng **`after()`** từ `next/server`, không phải
  `void promise` (xem 5.5).

### 5.2 Mọi truy vấn tenant phải lọc theo tổ chức

```ts
const ctx = await requirePermissionStrict("camera.update");
if (isError(ctx)) return ctx;

await admin
  .from("cameras")
  .update(patch)
  .eq("organization_id", ctx.organizationId) // ← BẮT BUỘC
  .eq("id", id);
```

Client dùng `createAdminClient()` là **service role — bỏ qua RLS hoàn toàn**.
RLS là lưới an toàn cuối chứ không phải lớp bảo vệ chính. Quên dòng `.eq` là rò
dữ liệu chéo khách hàng. CI có script chặn (mục 7.2).

Hai hàm guard, chọn đúng:

- `requirePermission(code)` — đọc role từ JWT, nhanh, dùng cho **đọc**.
- `requirePermissionStrict(code)` — đọc lại role từ DB + kiểm tài khoản còn
  active + kiểm org khớp. Dùng cho **mọi thao tác ghi**.

Danh sách mã quyền hiện có (36 mã) nằm trong bảng `role_permission_matrix`:

```
audit.view                        organization.view / update
camera.view / create / update     packing_station.view / create / update / archive
camera.archive / test             report.view
camera.recording.view / control   staff.view / create / update / delete
order_proof.view / generate       staff.invite / staff.qr.regenerate
user.view / create / update       station_device.view / create / update / archive
user.delete                       station_device_assignment.view / manage
warehouse.view / create           warehouse.update / delete
```

Route `/api/platform/*` **không** dùng hai hàm trên — platform admin không có
`organization_id`. Dùng `requirePlatformRole("platform_support" | "platform_owner")`.

### 5.3 Với request từ agent: danh tính lấy từ chữ ký, không lấy từ body

```ts
const headers = readAgentHeaders(req);
const rawBody = await req.text();                 // ← text() TRƯỚC, không json()
const { data: agent } = await admin.from("warehouse_agents")
  .select("id, organization_id, status, secret, hmac_v2_enforced_at")
  .eq("code", headers.code).maybeSingle();

const verdict = await verifyAgentRequest(admin, {
  rawBody, method: "POST",
  canonicalPath: AGENT_API_PATHS.<tên>,           // ← phải khớp bảng ở CẢ HAI bên
  headers, agentId: agent.id,
  hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
  secret: agent.secret,
});
if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });

// Từ đây dùng agent.organization_id. TUYỆT ĐỐI không đọc org từ body.
```

Phải `req.text()` chứ không `req.json()` vì chữ ký tính trên **chuỗi thô** —
parse rồi stringify lại là đổi byte, chữ ký sai ngay.

### 5.4 Ở client, gọi API qua `apiFetch` chứ không `fetch`

[src/lib/api-fetch.tsx](src/lib/api-fetch.tsx) tự gắn header `x-render-org-id`
cho request ghi và tự tải lại trang khi gặp 409 `org_context_changed`. Đây là
lớp chống ghi nhầm khi platform admin mở hai tab hai tổ chức khác nhau. Dùng
`fetch` trần là bỏ qua lớp đó.

### 5.5 Việc chạy sau khi trả response

```ts
import { after } from "next/server";
after(() => { hookLarkNotifyScan({ ... }); });
```

**Không** dùng `void somePromise()`. Trên serverless, lambda đóng băng ngay sau
response và promise trần bị giết giữa chừng — thông báo mất một cách phi định.

### 5.6 `supabase-js` không throw

Đây là nguồn của nhiều sự cố nhất trong dự án:

```ts
const { data } = await admin.from("x").select(); // ← SAI: bỏ rơi error
const { data, error } = await admin.from("x").select(); // ← ĐÚNG
if (error) {
  /* xử lý hoặc ít nhất log code + message */
}
```

RLS từ chối, service key hết hạn, Postgres 5xx — tất cả trả về qua `error`,
không ném exception. Viết `const { data } = ...` nghĩa là mọi hỏng hóc trở thành
"không có dữ liệu" một cách im lặng. CI có script chặn cho đường ghi audit.

### 5.7 Ghi audit cho thao tác quản trị

```ts
await audit({
  organizationId: ctx.organizationId,
  actorUserId: ctx.userId,
  actorEmail: ctx.email,
  action: "camera.recording.start.enqueued",
  targetType: "camera",
  targetId: id,
  metadata: { session_id, command_id },
});
```

Audit fail **không** được rollback nghiệp vụ chính, nhưng phải log ra console.

---

## 6. Vòng đời một thay đổi

```
1. Nhánh mới từ main
2. Code
3. pnpm typecheck && pnpm typecheck:tests && pnpm lint
4. pnpm test                       (cloud)
5. cd warehouse-agent && pnpm exec tsx --test tests/*.test.ts   (nếu đụng agent)
6. Chạy 6 script guard ở mục 7.2
7. Migration nếu có (mục 8)
8. Commit — message tiếng Việt, dạng feat(scope): / fix(scope):
9. Deploy (mục 10)
```

`pnpm build` tự chạy `prebuild` = `scripts/check-proof-clip-signed-url.mjs`. Nếu
build gãy ở đó, bạn vừa gọi `createSignedUrl` ở chỗ không được phép — xem bất
biến số 3.

---

## 7. Kiểm thử

### 7.1 Chạy test

```powershell
pnpm test                 # cloud — node --test, TS chạy thẳng không cần build
cd warehouse-agent
pnpm exec tsx --test tests/*.test.ts
```

Vài điều cần biết:

- [tests/register.mjs](tests/register.mjs) đặt **`TZ=UTC` mặc định**. Cố ý:
  production chạy UTC, và mọi bug lệch +7 giờ đều nổ ở đó. Test đứng ở giờ máy
  dev thì đúng lớp bug ấy sẽ xanh ở local rồi đỏ ở production (đã từng xảy ra —
  thẻ Lark hiện sai giờ).
- **Test bị loại khỏi `tsconfig.json`** và có `tsconfig.tests.json` riêng. Lý do
  ghi ngay trong tsconfig: test import module của agent, mà agent có dependency
  riêng (`zod`, `dotenv`) không được cài trong build của web — để chung là
  `next build` gãy trên CI. Nên phải chạy **hai** lệnh typecheck.
- ESLint bỏ qua toàn bộ `warehouse-agent/` — agent tự typecheck riêng.

### 7.2 Sáu guard CI — mỗi cái là một sự cố đã xảy ra

```powershell
node scripts/check-proof-clip-signed-url.mjs                # rò clip chéo tổ chức
node scripts/check-tenant-scoped-writes.mjs                 # route ghi quên lọc org
node scripts/check-agent-routes-use-verify-agent-request.mjs # route agent quên xác thực
node scripts/check-migration-versions.mjs                   # 2 migration trùng version
node scripts/check-apply-camera-probes-legacy.mjs           # gọi RPC probe bản cũ
node scripts/check-audit-destruct-error.mjs                 # audit bỏ rơi .error
```

Triết lý ở đây đáng học: khi một lỗi đã xảy ra **và** cách tránh nó là "nhớ cho
kỹ", thì viết script chặn thay vì viết vào tài liệu. Nếu bạn sửa một bug loại
"quên làm bước X", hãy cân nhắc thêm guard thứ bảy.

### 7.3 Viết test ở đâu

Test trong dự án này gần như chỉ nhắm vào **hàm thuần**. Đó là lý do tồn tại của
những file như `open-segment-verdict.ts`, `clip-window.ts`, `ui-state.ts`,
`evidence-coverage.ts`, `agent-auth-core.ts`. Khi bạn gặp logic quyết định quan
trọng nằm lẫn trong route, cách làm đúng ở repo này là **tách nó ra một hàm
thuần rồi test hàm đó**, chứ không dựng mock Supabase.

---

## 8. Migration

```powershell
supabase link --project-ref <ref>
supabase db push
```

Quy ước:

- Tên file: `<YYYYMMDDHHMMSS>_<mô_tả_ngắn>.sql`. Guard CI chặn hai file trùng
  phần version.
- Bảng mới **phải** có RLS. Xem các file `*_platform_aware.sql` làm mẫu — chúng
  xử lý cả tenant thường lẫn platform admin.
- Migration lớn thì viết kèm script xác minh ở `supabase/verify/`, và script
  rollback ở `supabase/rollback/` nếu có thể.
- Logic nghiệp vụ cần **nguyên tử** thì viết thành RPC chứ đừng ghép nhiều
  query ở tầng route. Xem `enqueue_clip_generation` (tạo row + tạo lệnh trong
  một transaction) hoặc `enqueue_start_recording` (advisory lock theo camera).

Các RPC đang có, để bạn khỏi viết lại: `process_waybill_scan`,
`process_staff_qr_session`, `resolve_scanner_at`, `resolve_station_camera_at`,
`claim_agent_commands`, `reap_stale_agent_commands`, `enqueue_start_recording`,
`enqueue_clip_generation`, `promote_clip_generation`, `apply_camera_probes_v2`,
`close_stale_sessions`, `reap_orphan_recording_sessions`.

---

## 9. Mười lăm bất biến — phá cái nào cũng có sự cố kèm theo

Đây là phần quan trọng nhất của tài liệu này. Mỗi dòng là một lần trả giá.

1. **Không query bảng tenant mà thiếu `.eq("organization_id", …)`.** Service role
   bỏ qua RLS. Hậu quả: rò dữ liệu chéo khách hàng.
2. **Không lấy `organization_id` từ body request của agent.** Lấy từ danh tính
   HMAC. Kẻ có secret của agent A gửi org B trong body vẫn chỉ được đụng org A.
3. **Không gọi `createSignedUrl` trực tiếp trên bucket clip.** Chỉ
   [proof-clip-signed-url.ts](src/lib/watch/proof-clip-signed-url.ts) được phép,
   vì Storage **không** có RLS hiệu lực với service role. Guard chặn ở prebuild.
4. **Không xoá `desired-recording.json` vì lỗi runtime**, kể cả lỗi phân loại là
   "vĩnh viễn". Đó là _ý định của người dùng_, không phải _sức khoẻ camera_. Đã
   cắn: camera chết im cả ngày sau khi kho tắt máy cuối ca.
5. **`null` khác `[]`.** Khi agent hỏi cloud "còn camera nào active", `null`
   nghĩa là _request hỏng, không biết gì_ → không thu hồi gì. `[]` nghĩa là
   _cloud nói không còn camera nào_ → thu hồi thật. Gộp hai cái: kho mất mạng vài
   phút là xoá sạch ý định ghi.
6. **Không gộp "không biết" với "không phải".** Kiểm quyền không kết luận được
   phải trả **503**, không phải 403. Mục tự kiểm không đo được phải trả
   `unknown`, không phải `ok`.
7. **Không tính lại cửa sổ clip ở nơi khác** — import `clip-window.ts`. Hai nơi
   tính lệch nhau thì cảnh báo dung lượng nói một số còn agent render ra số khác.
8. **Không tính lại trạng thái online camera** — import `online-state.ts`. Đã
   cắn: dashboard hiện "LIVE" trong khi bảng thiết bị hiện "Mất kết nối kho" cho
   cùng một camera.
9. **Không viết `const { data } = await supabase…`** — luôn destruct cả `error`.
10. **Mục tự kiểm không được throw.** Một mục hỏng không được kéo chết các mục
    kia. "Hệ theo dõi mà trả 500 là hệ theo dõi cần người theo dõi nó."
11. **Với ffmpeg concat, `-ss` đặt SAU `-i`.** Concat demuxer không hỗ trợ input
    seek; đặt trước thì ffmpeg lặng lẽ bỏ qua — đã đo, clip ra 74 giây thay vì 29.
12. **Spawn ffmpeg thì phải đọc stdout**, kể cả khi không cần dữ liệu. Pipe
    buffer Windows ~4KB; không ai đọc là nghẽn `write()` và treo cả tiến trình.
    Hiện tượng này từng bị chẩn nhầm suốt nhiều ngày là "timeout mạng".
13. **`AGENT_API_PATHS` phải sửa ở cả hai bên** (`src/lib/warehouse/` và
    `warehouse-agent/src/`). Path nằm trong chuỗi ký — lệch một ký tự là hỏng
    toàn bộ xác thực. Có test mirror chốt việc này.
14. **Việc sau response dùng `after()`**, không dùng `void promise`.
15. **Không đổi ngữ nghĩa `started_at` của segment.** Nó **parse từ tên file**
    (ffmpeg `-strftime` chốt tại lúc mở file), không phải "lúc chương trình nhìn
    thấy file". Đổi sang mốc quan sát thì độ dài segment sai và bộ cắt clip báo
    lỗ hổng giả.

---

## 10. Chạy ở production như thế nào

```
Người dùng ──HTTPS──► VPS: Next.js standalone (systemd)
                        │
                        ├──► Supabase: Postgres + Storage + Auth
                        │       └── pg_cron: reaper lệnh (mỗi phút)
                        │
                        └──► systemd timers trên chính VPS:
                               • dọn clip hết hạn
                               • đóng segment mồ côi
                               • tự kiểm hạ tầng (15 phút/lần) → cảnh báo Lark

Máy kho (Windows) ──poll 3s──► VPS
   agent .exe (nssm service) ──► camera RTSP trong LAN
```

Vài điều dễ vấp:

- **`output: "standalone"` trong [next.config.ts](next.config.ts) là bắt buộc.**
  Quy trình deploy chạy `.next/standalone/server.js`. Thiếu dòng đó thì build
  không sinh thư mục standalone và deploy gãy ở bước copy. Dòng này từng chỉ tồn
  tại trong một commit local trên VPS, chưa từng push — clone máy mới là gãy mà
  không ai hiểu vì sao.
- **`vercel.json` còn khai một cron** (`cleanup-clips` lúc 3 giờ sáng). Đó là
  **di sản từ thời chạy trên Vercel**. Lịch thật hiện nằm ở systemd timer trên
  VPS — file mẫu ở [docs/vps/](docs/vps/). Đây chính là chỗ từng làm cron dọn
  clip **chết âm thầm 5 ngày**: đổi hạ tầng mà lịch vẫn để ở file cũ.
- **Mỗi lần cron chạy đều ghi một dòng `system_jobs`**, kể cả khi lỗi. Mục tự
  kiểm đọc mốc đó để biết "cron còn sống không". Nếu bạn thêm job nền, nhớ ghi
  sổ — không thì nó chết im như lần trước.
- **Agent cài bằng installer Inno Setup**, chạy dưới nssm như một Windows
  service. Hướng dẫn cho khách:
  [warehouse-agent/CACH-CAI-KHACH.md](warehouse-agent/CACH-CAI-KHACH.md).

```powershell
cd warehouse-agent
pnpm run build:exe
& "C:\Program Files (x86)\Inno Setup 6\iscc.exe" installer/betacom-agent.iss
```

Agent hiện ở version 0.8.9. Nâng version thì nhớ cập nhật
[warehouse-agent/RELEASES.md](warehouse-agent/RELEASES.md) — khách cài bản nào
thì chỉ có file đó nói được.

---

## 11. Biến môi trường

**Cloud** (`.env.local`):

| Biến                                                                | Ghi chú                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Client                                                                           |
| `SUPABASE_SERVICE_ROLE_KEY`                                         | Server. Sai key → mọi kiểm quyền platform trả 503                                |
| `CAMERA_SECRET_KEY`                                                 | Mã hoá mật khẩu camera. **Mất khoá = mất toàn bộ mật khẩu camera của mọi khách** |
| `PLATFORM_ORG_CTX_SECRET`                                           | ≥ 32 ký tự. Thiếu là app **throw ngay lúc khởi động**                            |
| `CRON_SECRET`                                                       | Cho cron + tự kiểm                                                               |
| `LARK_NOTIFY_ENABLED`, `LARK_INFRA_WEBHOOK_URL`                     | Thông báo nghiệp vụ / hạ tầng (hai webhook **tách nhau**)                        |
| `BUCKET_TTL_HOURS` (72), `SIGNED_URL_TTL_SECONDS` (2700)            | Vòng đời clip / URL — hai số độc lập, đừng lẫn                                   |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `RECORDING_DIR`                      | Chỉ dùng cho route `test-draft` chạy on-prem                                     |

**Agent** (`warehouse-agent/.env`):

| Biến                                        | Mặc định             |
| ------------------------------------------- | -------------------- |
| `BACKEND_URL`, `AGENT_CODE`, `AGENT_SECRET` | —                    |
| `RECORDING_DIR`                             | `./recordings`       |
| `FFMPEG_PATH` / `FFPROBE_PATH`              | `ffmpeg` / `ffprobe` |
| `POLL_INTERVAL_MS`                          | 3000                 |
| `HEARTBEAT_INTERVAL_MS`                     | 30000                |
| `CAMERA_PROBE_INTERVAL_MS`                  | 30000                |
| `MAX_PROOF_CLIP_UPLOAD_BYTES`               | 90 MiB               |

Con số 90 MiB **đo được chứ không phải đọc ô cấu hình** — bằng cách PUT tăng dần
qua đúng đường signed URL (`scripts/probe-storage-upload-limit.mjs`). Nếu đổi gói
Supabase thì đo lại rồi mới sửa.

---

## 12. Sổ tay gỡ lỗi

| Triệu chứng                                          | Nhìn ở đâu trước                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard nói "Đang ghi" mà không có file mới trên ổ | Watchdog runtime — [ffmpeg-runtime-watchdog.ts](warehouse-agent/src/ffmpeg-runtime-watchdog.ts). ffmpeg treo mà không exit thì mọi tầng retry đều không kích |
| Clip kẹt "Đang cắt" mãi                              | Ba lớp ở mục C9 của [giaithich.md](giaithich.md): outbox agent → reconcile cloud → [stale-pending.ts](src/lib/order-proof/stale-pending.ts)                  |
| Một camera không cắt được clip cho **mọi** đơn       | Row segment mồ côi (`ended_at IS NULL` quá cũ). Xem [open-segment-verdict.ts](src/lib/order-proof/open-segment-verdict.ts) + cron `close-orphan-segments`    |
| Bấm "Tạm ngưng" mà camera vẫn bị ghi                 | `listCameraCredentials` phải lọc `status='active'`; kiểm cả `syncDesiredWithActiveCameras` ở agent                                                           |
| Không dừng được ghi hình, API trả 409                | `getOpenSessionForStop` — điều kiện phải là `stopped_at IS NULL`, không phải `status='recording'`                                                            |
| Platform admin bị đá về dashboard tenant             | Service key hỏng. [admin-check.ts](src/lib/platform/admin-check.ts) phải trả `unavailable` → 503                                                             |
| Clip cắt ra ngắn hơn thực tế                         | Đơn còn `open` lúc cắt. [proof-clip-gate.ts](src/lib/order-proof/proof-clip-gate.ts)                                                                         |
| Timestamp lệch giờ                                   | `warehouse_agents.time_drift_seconds`. Đồng hồ máy kho lệch là clip cắt lệch — sửa bằng `w32tm`                                                              |
| Segment cuối trong ngày hỏng "moov not found"        | Shutdown agent bị cắt ngắn, ffmpeg không kịp ghi trailer. Xem `shutdown()` trong [agent/index.ts](warehouse-agent/src/index.ts)                              |
| Lệnh agent kẹt `taken` mãi                           | pg_cron reaper. **Ai tắt job đó thì lệnh không bao giờ được cứu và không có thông báo lỗi nào**                                                              |
| Request tăng vọt / vượt hạn mức                      | [visibility-poller.ts](src/lib/polling/visibility-poller.ts) và cơ chế piggy-back ở `/api/agent/camera-probe`                                                |

Đường log của agent: nó tự đẩy lên cloud qua `/api/agent/log-events`
([remote-logger.ts](warehouse-agent/src/remote-logger.ts)), xem ở bảng
`agent_log_events`. Không cần RDP vào máy kho để đọc log — đó là lý do module đó
tồn tại.

---

## 13. Từ điển thuật ngữ

| Từ                 | Nghĩa trong dự án này                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| **tenant / org**   | Một khách thuê. Mọi bảng nghiệp vụ đều có `organization_id`                 |
| **platform**       | Betacom, chủ sản phẩm. Khu `/platform/*`, quyền riêng                       |
| **impersonate**    | Platform admin xem dashboard của một khách để hỗ trợ                        |
| **agent**          | Chương trình `.exe` chạy trong kho khách                                    |
| **command**        | Một dòng `agent_commands`. `pending → taken → done/failed`                  |
| **desired**        | File trên ổ agent: "camera nào NÊN đang ghi". Ý định, không phải trạng thái |
| **segment**        | Một file mp4 60 giây do ffmpeg cắt tự động, ghi 24/7                        |
| **clip**           | Đoạn cắt ra từ các segment cho **một đơn hàng**. Đây mới là bằng chứng      |
| **packing_event**  | Một lần quét mã vận đơn = một đơn được đóng gói                             |
| **work session**   | Ca làm việc của một nhân viên tại một bàn                                   |
| **probe**          | Ping TCP cổng RTSP mỗi 30 giây để biết camera còn sống                      |
| **reaper**         | Job kéo lệnh quá hạn từ `taken` về `pending`                                |
| **evicted**        | Clip đã bị dọn khỏi bucket sau 72 giờ nhưng từng cắt thành công             |
| **superseded**     | Clip cũ bị thay thế bởi lần cắt mới                                         |
| **capped_timeout** | Đơn kéo dài quá ngưỡng nghiệp vụ, thời lượng bị cắt trần                    |
| **timing_status**  | `open` (chưa đóng) / `finalized_by_next_scan` / `capped_timeout` / …        |

---

## 14. Nợ kỹ thuật đang mở

Tôi để lại nguyên trạng, có ghi lý do trong code. Đừng ngạc nhiên khi gặp:

1. **Chưa chặn được hai agent cùng ghi một camera.** Guard chống trùng chỉ nguyên
   tử trong một tiến trình Node. Hàng rào còn lại là unique index ở DB, nhưng nó
   chỉ cứu nếu cả hai đi qua backend tạo session _trước khi_ spawn ffmpeg. Hiện
   mỗi tổ chức chỉ một agent nên chưa cắn. **Phải xử lý trước khi có khách thứ
   hai dùng nhiều agent.** Xem khối `BLOCKS-GO-LIVE` đầu
   [recording.ts](warehouse-agent/src/recording.ts).
2. **Mô hình đang là 1 tổ chức = 1 agent.** Nhiều chỗ suy org từ agent mà không
   có `warehouse_id`. Kho thứ hai của cùng một khách sẽ lộ ra chỗ này —
   [agent-liveness.ts](src/lib/watch/agent-liveness.ts) đã ghi sẵn nơi cần sửa.
3. **HMAC v1 (không nonce, replay được) vẫn còn** cho agent chưa nâng cấp. Bật
   cưỡng chế v2 theo từng agent qua cột `hmac_v2_enforced_at`.
4. **Cửa sổ quét bù lúc agent khởi động vẫn là "N ngày cứng"** (mặc định 30)
   thay vì "từ mốc file cuối cùng cloud đã biết". Luôn có ca kho nghỉ dài hơn N.
5. **`react-hooks/set-state-in-effect` đang để `warn`** thay vì `error`. Các
   trang còn fetch-in-effect kiểu cũ. Xem TODO trong
   [eslint.config.mjs](eslint.config.mjs).
6. **Route `test-draft` chạy ffmpeg ngay trên cloud** — chỉ có nghĩa khi cài
   on-prem. Trên SaaS nó không tới được camera.

---

## 15. Tuần đầu tiên nên đi thế nào

**Ngày 1** — Dựng máy chạy được (mục 3). Đăng nhập dashboard, bấm hết các trang.
Đọc mục 1, 2, 5 của tài liệu này.

**Ngày 2** — Đọc [giaithich.md](giaithich.md) mục 5 (camera) và mục 6 (clip
bằng chứng). Đây là 70% giá trị của hệ thống. Vừa đọc vừa mở file được nhắc tới.

**Ngày 3** — Dựng agent chạy ở local, trỏ vào backend dev. Xem nó poll, xem log
đi lên `agent_log_events`. Nếu có camera IP nào (kể cả webcam qua phần mềm giả
RTSP) thì cho ghi thử.

**Ngày 4** — Đọc đường đi của **một** request từ đầu tới cuối:
`proxy.ts` → `guard.ts` → một route bất kỳ → RPC → về UI. Chọn
`/api/cameras/[id]/recording/start` — nó ngắn mà chạm đủ mọi lớp.

**Ngày 5** — Nhận một task nhỏ. Gợi ý task tốt cho người mới: thêm một mục vào
tự kiểm hạ tầng ([checks.ts](src/lib/system/checks.ts)). Nó độc lập, có sẵn
khuôn mẫu, có test, và ép bạn phải hiểu ranh giới `ok`/`warn`/`unknown`/`skipped`
— đúng thứ tư duy mà toàn bộ codebase này dựa vào.

---

## 16. Một lời cuối

Codebase này có **rất nhiều comment dài**. Đó không phải rác, và tuyệt đối đừng
dọn. Gần như mỗi khối comment dài là một sự cố production có ngày tháng cụ thể,
kèm lý do vì sao cách làm hiển nhiên lại sai. Chúng là thứ duy nhất giữ cho
những quyết định trông có vẻ kỳ quặc khỏi bị "sửa lại cho hợp lý" rồi tái phát
sự cố cũ.

Quy tắc của tôi: **đọc comment trước khi sửa đoạn code nó bọc.** Nếu bạn sửa một
bug và phát hiện ra rằng cách làm hiển nhiên là sai, hãy viết thêm một khối như
vậy — kèm ngày, kèm triệu chứng, kèm con số đo được. Người tiếp theo sẽ cảm ơn
bạn, y như tôi đang cảm ơn những người trước.

Chúc bạn vào việc thuận lợi.
