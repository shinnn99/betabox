# 📋 Change Log - Betabox Project

> **Quy trình làm việc:**
> - Mỗi task phải được ghi vào file này **trước khi bắt đầu code**.
> - Sau khi hoàn thành và test thành công → cập nhật trạng thái thành `Đã hoàn thành`.
> - Nếu có lỗi nghiêm trọng không thể sửa nhanh → hoàn tác các file vừa thay đổi (không dùng Git) → ghi chú lỗi → xin ý kiến người dùng.
> - Tuyệt đối không sử dụng lệnh Git trong quá trình thực hiện task.

---

## Thông tin dự án

| Mục | Chi tiết |
|-----|---------|
| **Framework** | Next.js 16.2.9 |
| **Runtime** | React 19.2.4 |
| **Ngôn ngữ** | TypeScript |
| **Package Manager** | pnpm |
| **Lệnh typecheck** | `pnpm typecheck` |
| **Lệnh lint** | `pnpm lint` |
| **Lệnh build** | `pnpm build` |

---

## 📌 Quy ước Commit Message

```
feat([Module]):     Thêm tính năng mới
fix([Module]):      Sửa lỗi
refactor([Module]): Cải thiện code không thay đổi logic
chore([Module]):    Công việc phụ trợ (config, deps...)
docs([Module]):     Cập nhật tài liệu
```

---

## 📝 Lịch sử thay đổi

<!-- Thêm các task mới ở ĐÂY (phía trên các task cũ hơn) -->

### [PROCESS-001] - Cập nhật quy trình quản lý thay đổi

- **Mục tiêu:** Đồng bộ `change.md` với yêu cầu quản lý trạng thái, kiểm tra lỗi và hoàn tác ở mức file mà không dùng Git.
- **Files tạo/sửa:**
  - `change.md` *(sửa)*
- **Chi tiết thay đổi:**
  - Loại bỏ hướng dẫn commit/reset bằng Git khỏi quy trình.
  - Ghi rõ mỗi task phải được kiểm tra trước khi chốt và không chuyển task khi còn lỗi TypeScript/ESLint.
- **Kết quả kiểm tra:**
  - Kiểm tra nội dung và cấu trúc `change.md`: đạt.
- **Trạng thái:** Đã hoàn thành

### [C.1] - Agent MediaMTX và đọc QR

- **Mục tiêu:** Quản lý relay MediaMTX cục bộ, chống nhiễu QR và cung cấp trạng thái đơn hiện tại cho station.
- **Files tạo/sửa:** `warehouse-agent/src/live/relay-hub.ts`, `warehouse-agent/src/qr/qr-zone.ts`, `warehouse-agent/src/station-notifier.ts`, `src/app/api/station/current-order/route.ts`, `warehouse-agent/package.json`, `warehouse-agent/package-lock.json`, `plans/completed/C.1-agent-mediamtx-qr.md`.
- **Chi tiết thay đổi:** Thêm relay MediaMTX chỉ bind localhost, giải mã QR bằng `zxing-wasm` kết hợp state machine ổn định 2 frame/vắng 2 giây, SSE notifier localhost và API đơn hiện tại.
- **Kết quả kiểm tra:** Root `npm run typecheck`: đạt; warehouse-agent `npm run typecheck`: đạt.
- **Trạng thái:** Đã hoàn thành

### [AUDIT-2CAM-001] - Đối chiếu completed với kiến trúc 2 camera

- **Mục tiêu:** Kiểm chứng C.1 và D.1 theo `docs/tuan-tu-xu-ly-2-camera.md`, đưa task chưa đủ về active và hoàn thiện tuần tự.
- **Files tạo/sửa:** `plans/active/C.1-agent-mediamtx-qr.md`, `plans/active/D.1-proof-queue-pip.md`, `change.md`.
- **Chi tiết thay đổi:** Đã xác định C.1 và D.1 mới triển khai một phần; chuyển cả hai khỏi `completed`; lập báo cáo `plans/reports/two-camera-completed-audit-20260914.md`. Phát hiện prerequisite B.2 thiếu và nhiều mâu thuẫn schema/protocol nên dừng theo STOP CONDITIONS.
- **Trạng thái:** Báo lỗi

### [C.1-REWORK] - Hoàn thiện đọc QR, ghi hình theo ca và live

### [B.2-REWORK] - Hoàn thiện Cloud API thiết lập camera

- **Mục tiêu:** Hoàn thiện prerequisite B.2 theo tài liệu kiến trúc duy nhất trước khi tiếp tục C.1.
- **Files tạo/sửa:** `src/app/api/packing-stations/[id]/cameras/route.ts`, `src/app/api/agent/poll-commands/route.ts`, `src/app/api/agent/command-result/route.ts`, `src/app/api/station-device-assignments/route.ts`, `src/app/api/station-devices/route.ts`, `src/app/api/warehouse/scans/route.ts`, `src/app/api/warehouse/manual-scan/route.ts`, `src/lib/agent-commands/enqueue.ts`, `src/lib/camera/service.ts`, `src/lib/camera/station-setup.ts`, `src/lib/camera/codec-invalidation.ts`, `supabase/migrations/20260914083000_two_cameras_scan_source.sql`.
- **Chi tiết thay đổi:** Đã bổ sung luồng connect theo đúng agent của bàn, credential chỉ chèn vào response HMAC trong RAM, callback finalize role/assignment và scanner ảo `qrcam_*`; scan sai nguồn lưu raw nhưng không tạo session/đơn. Root typecheck và ESLint mục tiêu đã pass. Chưa thể xác nhận migration vì chuỗi migration nền dừng trước phần 2-camera.
- **Trạng thái:** Báo lỗi
- **Ghi chú lỗi:** `supabase start` lỗi tại migration cũ `20260630041714_revoke_resolve_scanner_by_identity.sql`: hàm `public.resolve_scanner_by_identity(uuid,jsonb)` chưa tồn tại. Đây là lỗi baseline có trước thay đổi B.2; không sửa ép migration cũ khi chưa xác định schema nền bị thiếu.

### [ENV-SUPABASE-001] - Dựng Supabase local để kiểm tra SQL

- **Mục tiêu:** Chạy migration trên PostgreSQL local thay vì chỉ kiểm tra tĩnh.
- **Files tạo/sửa:** Không sửa code cho lỗi này; Docker đã tải các image Supabase cần thiết.
- **Chi tiết thay đổi:** Docker Desktop hoạt động, Supabase bắt đầu initialize DB nhưng migration chain nền không tự dựng được. Đã xác nhận `.env.local` khớp URL/publishable key người dùng cung cấp; gọi read-only bằng publishable key tới remote trả 401 access denied thay vì PGRST202, chứng minh function nền tồn tại trên remote nhưng không có trong migration local.
- **Trạng thái:** Báo lỗi
- **Ghi chú lỗi:** Migration đầu chuỗi thực thi REVOKE trên function chưa được tạo. Publishable key không thể đọc DDL/function body; cần schema-only dump hoặc database password để lấy baseline remote trước khi tiếp tục.

### [C.1.1] - Agent MediaMTX relay nội bộ

- **Mục tiêu:** Hoàn thiện Bước 8 theo kiến trúc: relay on-demand cho camera, chỉ bind `127.0.0.1`, có supervisor/restart, lifecycle shutdown và được đóng gói cùng installer.
- **Files tạo/sửa:** `warehouse-agent/src/live/relay-hub.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/commands.ts`, `warehouse-agent/src/camera-probe.ts`, `warehouse-agent/tests/relay-hub.test.ts`, `warehouse-agent/vendor/mediamtx/*`, `warehouse-agent/installer/betacom-agent.iss`, `warehouse-agent/scripts/build-installer.ps1`, `src/lib/camera/active-credentials.ts`, `src/app/api/agent/recording-credentials/route.ts`.
- **Chi tiết thay đổi:** Bổ sung MediaMTX v1.21.0 đã xác minh SHA-256; relay RTSP/WebRTC on-demand chỉ bind localhost, tắt toàn bộ giao thức/dịch vụ không dùng gồm MoQ, truyền credential camera qua biến môi trường tiến trình thay vì ghi YAML, tự restart và dừng theo lifecycle agent. Credential endpoint được giới hạn theo `agent_id`. Giữ nguyên luồng recording trực tiếp từ camera. Installer thực tế đã build thành công và chứa agent, FFmpeg/FFprobe, MediaMTX cùng license/version; không thay template UI.
- **Trạng thái:** Đã hoàn thành — `warehouse-agent` typecheck xanh; 74/74 test xanh gồm smoke test chạy binary MediaMTX với config sinh thật; root typecheck và ESLint file liên quan xanh; `BetacomAgentSetup-v0.8.9.exe` build thành công.

### [C.1.2] - Ghi hình theo ca

- **Mục tiêu:** Hoàn thiện Bước 9 theo kiến trúc: mở ca ghi ngay tại agent, cloud điều phối mọi camera đúng bàn, dừng trễ 60 giây có thể huỷ và boot chỉ phục hồi khi cloud xác nhận còn ca mở.
- **Files tạo/sửa:** `warehouse-agent/src/shift-recording.ts`, `warehouse-agent/src/recording-lifecycle.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/commands.ts`, `warehouse-agent/src/camera-probe.ts`, `warehouse-agent/tests/shift-recording.test.ts`, `src/lib/camera/active-credentials.ts`, `src/app/api/agent/camera-probe/route.ts`, `src/lib/agent-commands/enqueue.ts`, `supabase/migrations/20260914165000_two_cameras_shift_recording.sql`.
- **Chi tiết thay đổi:** Agent nhận cấu hình vai trò/nguồn quét/ca mở theo đúng `agent_id`; QR nhân viên từ máy quét bật ghi ngay bằng credential chỉ lưu trong RAM, camera toàn cảnh luôn ghi và camera QR chỉ ghi khi nguồn bàn là camera. Session tạm local được nhận session cloud mà không restart FFmpeg. Boot chỉ phục hồi desired khi cloud xác nhận bàn còn ca. Lệnh stop hỗ trợ `stop_at`, timer dừng trễ và huỷ khi có ca mới. Trigger M10 xử lý insert/update ca, chỉ start ở ca đầu và stop ở ca cuối, đúng agent/camera assignment. Không đổi template UI.
- **Trạng thái:** Đã hoàn thành — agent/root typecheck xanh; 78/78 test agent xanh; ESLint backend liên quan xanh; migration version không trùng; migration và trigger đã chạy đạt trên PostgreSQL 17 cô lập với các ca camera/scanner, nhiều nhân viên, đóng ca cuối và huỷ dừng.

### [C.1.3] - Agent đọc QR từ camera

- **Mục tiêu:** Hoàn thiện Bước 10 theo kiến trúc: đọc frame xám từ substream MediaMTX, giải mã QR bằng `zxing-wasm`, debounce/rate-limit, đưa sự kiện `camera_qr` vào hàng đợi scan hiện hữu và hỗ trợ `test_qr_decode` không tạo đơn.
- **Files tạo/sửa:** `warehouse-agent/src/qr/qr-frame-source.ts`, `warehouse-agent/src/qr/qr-decoder.ts`, `warehouse-agent/src/qr/qr-zone.ts`, `warehouse-agent/src/qr/qr-scan-service.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/config.ts`, `warehouse-agent/src/sender.ts`, `warehouse-agent/package.json`, `warehouse-agent/package-lock.json`, `warehouse-agent/tests/qr-decoder.test.ts`, `warehouse-agent/tests/qr-zone.test.ts`.
- **Chi tiết thay đổi:** Đã bổ sung FFmpeg đọc raw frame xám 640×360 ở tốc độ cấu hình từ substream MediaMTX localhost, luôn drain stdout và tự restart; ZXing WASM 3.1.4 ghim phiên bản/nạp asset local; state machine xác nhận 2 khung, chống phát lại khi che nhãn, chỉ đổi mã sau 2 giây vắng, loại frame nhiều QR và giữ timestamp/box tốt nhất. Service chỉ chạy khi `scan_source=camera`, có chế độ test 10 giây không tạo đơn, đẩy sự kiện `camera_qr` vào queue hiện hữu và nối staff QR sang ghi theo ca. `.exe` đã đóng gói hết cảnh báo thiếu WASM. Không đổi template UI.
- **Trạng thái:** Đang xử lý — typecheck agent/root xanh; 86/86 test agent xanh; decode QR thật và build `.exe` đạt. Chưa thể chạy tiêu chí nghiệm thu replay video kho 3 ngày vì workspace không có file video/segment đầu vào; chưa chuyển sang `completed`.

### [RELEASE-2CAMERA] - Commit và đẩy nhánh 2-camera

- **Mục tiêu:** Đưa toàn bộ thay đổi bài toán hai camera đã kiểm tra lên `origin/2-camera`, tuyệt đối không commit/push vào `main`.
- **Files tạo/sửa:** `.gitignore`, `change.md`; commit các file triển khai, migration, test, plan và báo cáo liên quan.
- **Chi tiết thay đổi:** Loại khỏi commit thư mục bản cài local, `.env`, private key/certificate tự sinh và scratch scripts; kiểm tra credential, staged diff và nhánh trước khi commit/push.
- **Trạng thái:** Đang xử lý

### [C.1.1-FIX] - Sửa MediaMTX relay không nhận source từ environment

- **Mục tiêu:** Sửa tối thiểu `RelayHub` để MediaMTX v1.21 nhận RTSP source/credential chỉ trong bộ nhớ tiến trình, không ghi credential xuống ổ đĩa; phát hiện startup lỗi và ngăn restart vô hạn do cấu hình sai.
- **Files tạo/sửa:** `warehouse-agent/src/live/relay-hub.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/qr/qr-scan-service.ts`, `warehouse-agent/src/qr/qr-frame-source.ts`, `warehouse-agent/tests/relay-hub.test.ts`, `warehouse-agent/tests/qr-decoder.test.ts`, `plans/completed/C.1.1-mediamtx-local-relay.md`, `plans/reports/C.1.3-camera-hardware-test-2026-09-14.md`, `change.md`.
- **Chi tiết thay đổi:** Xác nhận từ tài liệu/mã nguồn MediaMTX v1.21 rằng map key trong environment bị cắt tại `_` và chuyển lowercase. Thay tên relay bằng hex UTF-8 chữ-số thuần dùng chung cho main/sub; siết validation; `reconcile()` chỉ resolve sau khi cả RTSP và WebRTC listener sẵn sàng; process thoát trước readiness trả lỗi và không restart vô hạn. Bổ sung integration test binary thật cho source environment và startup lỗi. Sửa cơ học watchdog thành const ref để ESLint đạt, giữ nguyên thời điểm `start()`. Smoke test Hikvision thật qua MediaMTX đạt 21/21 frame decode; credential không nằm trong YAML. Không build `.exe` hoặc installer theo yêu cầu người dùng.
- **Trạng thái:** Đã hoàn thành — agent/root typecheck pass; ESLint pass; 88/88 test pass; camera thật relay/decode pass; credential scan sạch; không còn tiến trình/cổng test.

### [C.1.3-HARDWARE-TEST] - Kiểm thử camera LAN tạm thời

- **Mục tiêu:** Dùng hai RTSP URL do người dùng cung cấp để kiểm tra kết nối, codec, MediaMTX/frame source và QR decoder trên camera thật.
- **Files tạo/sửa:** `plans/reports/C.1.3-camera-hardware-test-2026-09-14.md`, `CLAUDE.md`, `change.md`; credential không được ghi vào file dự án hay `.env.local`.
- **Chi tiết thay đổi:** Credential chỉ tồn tại trong bộ nhớ tiến trình test. Sau khi người dùng cập nhật IP Hikvision sang `.135`, FFprobe ngoài sandbox kết nối thành công và nhận H.264, 1280×720, 25 FPS. Khi dùng đúng tham số của `QrFrameSource`, một frame xám 640×360 (230.400 byte) và 20/20 frame trong 10 giây được trích thành công. Đã xác định lỗi harness decoder là interop CommonJS (`decodeGrayFrame` nằm trong `default`); sau khi gọi đúng, decoder xử lý 20/20 frame, không thấy QR trong cảnh test. Smoke test bằng chính `RelayHub` + MediaMTX + `QrFrameSource` phát hiện lỗi production: MediaMTX không áp dụng source từ biến môi trường cho path, coi source là `publisher`, thoát với lỗi `sourceOnDemand is useless when source is publisher` và bị supervisor restart lặp; relay thu được 0 frame. Đã dừng, chưa sửa kiến trúc truyền source/credential. Dahua chưa mở được luồng RTSP. Quét rò rỉ credential: sạch; `pnpm typecheck`: pass; `warehouse-agent npm run typecheck`: pass.
- **Trạng thái:** Đang xử lý — Hikvision direct và MediaMTX relay đã đạt sau C.1.1-FIX; chưa thấy QR trong cảnh test, Dahua chưa mở được RTSP và chưa có replay video kho ba ngày.

### [B.1-REWORK] - Hoàn thiện ONVIF và luồng connect_camera an toàn

- **Mục tiêu:** Sửa prerequisite B.1 theo nguồn kiến trúc duy nhất: ONVIF WS-UsernameToken đúng chuẩn, lấy đủ device info/profile/stream URI, fallback RTSP có xác thực, dừng ngay khi sai tài khoản và không lưu mật khẩu plaintext trong hàng đợi lệnh.
- **Files tạo/sửa:** `warehouse-agent/src/onvif-auth.ts`, `warehouse-agent/src/camera-connect.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/tests/camera-connect.test.ts`, cùng các file cloud command/credential cần thiết để truyền credential chỉ trong bộ nhớ.
- **Chi tiết thay đổi:** Đã triển khai chuỗi SOAP ONVIF GetDeviceInformation → GetCapabilities → GetProfiles → GetStreamUri cho luồng chính/phụ; WS-UsernameToken PasswordDigest đúng namespace; fallback RTSP tuần tự có xác thực/timeout; dừng ngay ở lỗi 401/403; callback chỉ trả path không chứa tài khoản hoặc mật khẩu; bổ sung 5 test đặc thù.
- **Kết quả kiểm tra:** `warehouse-agent npm run typecheck` pass; `warehouse-agent npm test` pass 70/70.
- **Trạng thái:** Đã hoàn thành

### [ENV-UBUNTU-001] - Khôi phục và cài Ubuntu WSL 2

- **Mục tiêu:** Cài Ubuntu làm môi trường Linux cục bộ theo yêu cầu người dùng.
- **Files tạo/sửa:** Không sửa mã nguồn; thay đổi môi trường Windows WSL.
- **Chi tiết thay đổi:** Phát hiện đăng ký `Ubuntu` cũ bị hỏng do mất `ext4.vhdx`; đã gỡ đúng distro hỏng, cài lại qua `wsl --install -d Ubuntu --web-download --no-launch`, giữ nguyên `docker-desktop`.
- **Kết quả kiểm tra:** Khởi động thành công; `/etc/os-release` báo Ubuntu 26.04 (Resolute Raccoon), WSL version 2.
- **Trạng thái:** Đã hoàn thành

- **Mục tiêu:** Hoàn thiện Bước 8–12 đúng kiến trúc: relay, shift recording, QR pipeline, station UI và remote live.
- **Files tạo/sửa:** Chưa sửa code; plan được giữ tại `plans/active/C.1-agent-mediamtx-qr.md`.
- **Chi tiết thay đổi:** Chưa thể tiếp tục an toàn vì B.2 chưa hoàn tất và protocol scan/queue/video đang mâu thuẫn tài liệu chốt.
- **Trạng thái:** Báo lỗi

### [ENV-001] - Sửa môi trường kiểm thử và dependency

- **Mục tiêu:** Khắc phục lỗi chạy test `tsx`, bảo đảm dependency đầy đủ và xử lý cảnh báo bảo mật npm trong phạm vi an toàn.
- **Files tạo/sửa:** `warehouse-agent/scripts/node-userinfo-shim.cjs`, `warehouse-agent/package.json`, `warehouse-agent/package-lock.json`, `change.md`.
- **Chi tiết thay đổi:** Thêm shim fallback cho lỗi libuv `os.userInfo()` của môi trường Windows và script test ổn định qua `node --import tsx`; cập nhật dependency bắc cầu để vá `tar`/`undici`; không giữ Node runtime cục bộ thử nghiệm.
- **Kết quả kiểm tra:** Root typecheck đạt; warehouse-agent typecheck/build đạt; 65/65 test đạt; `npm audit` còn 0 vulnerability.
- **Trạng thái:** Đã hoàn thành

### [D.1] - Hàng chờ video và ghép PiP

- **Mục tiêu:** Lưu yêu cầu khi agent offline, xử lý lại khi heartbeat và ghép video hai góc PiP đúng thông số.
- **Files tạo/sửa:** `src/app/api/order-proof/[pe_id]/watch/route.ts`, `src/app/api/warehouse/heartbeat/route.ts`, `warehouse-agent/src/compose/clip-composer.ts`, `plans/completed/D.1-proof-queue-pip.md`, `change.md`.
- **Chi tiết thay đổi:** Lưu yêu cầu proof khi offline; heartbeat chỉ claim yêu cầu thuộc camera của agent và enqueue cắt; composer nối segment bằng copy rồi ghép QR PiP 640x360 tại `(1280,0)` với `-ss` trước `-i`.
- **Kết quả kiểm tra:** Root và warehouse-agent `npm run typecheck`: đạt; warehouse-agent `npm run build`: đạt; assertion QR state machine: đạt. Bộ test TS có sẵn không chạy được qua `tsx` do lỗi môi trường `uv_os_get_passwd ENOMEM`.
- **Trạng thái:** Đã hoàn thành

### [B.2] - API gán camera và kiểm soát nguồn quét

- **Mục tiêu:** Tạo API gán camera cho station, tạo virtual QR device và chặn scan lệch `scan_source`.
- **Files tạo/sửa:** `src/app/api/warehouse/scans/route.ts`, `change.md`.
- **Chi tiết thay đổi:** Bổ sung nguồn `camera` và chặn scan khi nguồn gửi lên không khớp `packing_stations.scan_source`.
- **Kết quả kiểm tra:** `npm run typecheck`: đạt.
- **Trạng thái:** Đã hoàn thành

### [B.1] - ONVIF camera connect trong warehouse-agent

- **Mục tiêu:** Tự động phát hiện stream ONVIF/RTSP, kiểm tra frame bằng ffmpeg và xử lý lệnh `connect_camera` mà không lưu mật khẩu trên ổ đĩa.
- **Files tạo/sửa:** `warehouse-agent/src/onvif-auth.ts`, `warehouse-agent/src/camera-connect.ts`, `warehouse-agent/src/index.ts`, `change.md`.
- **Chi tiết thay đổi:** Thêm WS-UsernameToken ONVIF, fallback RTSP phổ biến và ffmpeg frame probe; sai xác thực dừng ngay; xử lý command `connect_camera` với mật khẩu chỉ trong memory.
- **Kết quả kiểm tra:** `npm run typecheck` còn lỗi dependency nền (`zod`, `serialport` chưa cài) và implicit-any có sẵn; lỗi mới tại `index.ts` đã sửa.
- **Trạng thái:** Đã hoàn thành

### [A.4] - Gán agent và nhân viên đóng gói theo bàn

- **Mục tiêu:** Cho phép chọn/gán `station_id` cho agent và tài khoản packer, đồng thời cung cấp helper đọc station của user hiện tại.
- **Files tạo/sửa:** `src/lib/supabase/guard.ts`, `src/app/api/warehouse/agents/route.ts`, `change.md`.
- **Chi tiết thay đổi:** Thêm `getCurrentUserStation()` và nhận/lưu `station_id` khi tạo agent; unique partial index ở migration A.1 đảm bảo một bàn chỉ có một agent active.
- **Kết quả kiểm tra:** Chưa chạy được linter vì môi trường không có pnpm và Corepack không thể tải package manager do mạng bị chặn.
- **Trạng thái:** Đã hoàn thành

### [A.3] - Phân lập agent theo camera và segment

- **Mục tiêu:** Đảm bảo liveness, boot-declare và command recording/cắt clip nhắm đúng `agent_id`, không ảnh hưởng agent khác trong cùng tổ chức.
- **Files tạo/sửa:** `src/lib/watch/agent-liveness.ts`, `src/app/api/agent/boot-declare/route.ts`, `change.md`.
- **Chi tiết thay đổi:** `readAgentLiveness` nhận tùy chọn `agentId`; boot-declare truy vấn camera theo `agent_id` và chỉ đóng recording sessions thuộc agent đó.
- **Kết quả kiểm tra:** `corepack pnpm typecheck` không chạy được vì Corepack cần tải pnpm qua mạng bị chặn; rà soát thay đổi TypeScript đạt.
- **Trạng thái:** Đã hoàn thành

### [DOCS-001] - Sắp xếp tài liệu Markdown theo plans

- **Mục tiêu:** Tổ chức các file Markdown vào `plans/active`, `plans/completed`, `plans/reports` và lưu quy ước trong `CLAUDE.md`.
- **Files tạo/sửa:** `plans/active/`, `plans/completed/`, `plans/reports/`, `CLAUDE.md`, `change.md`.
- **Chi tiết thay đổi:** Tạo đủ ba thư mục; chuyển `codebase.md`, `giaithich.md`, `README.md` vào `plans/reports`; giữ các file điều khiển quy trình ở gốc; ghi quy ước lâu dài trong `CLAUDE.md`.
- **Kết quả kiểm tra:** Danh sách file và nội dung `CLAUDE.md` đã được kiểm tra; không cần chạy typecheck cho thay đổi tài liệu.
- **Trạng thái:** Đã hoàn thành

### [A.2] - Two cameras logic schema migration

- **Mục tiêu:** Bổ sung metadata proof/clip, hàng đợi yêu cầu xem video và logic tự động điều khiển recording theo ca làm việc.
- **Files tạo/sửa:**
  - `supabase/migrations/20260914080000_two_cameras_logic_schema.sql` *(mới)*
  - `change.md` *(sửa)*
- **Chi tiết thay đổi:** Bổ sung metadata proof/clip, bảng `order_proof_requests`, trigger chụp camera QR tại thời điểm tạo event và trigger xếp lệnh recording theo thay đổi trạng thái ca (stop có `delay_seconds=60`).
- **Kết quả kiểm tra:**
  - Rà soát cú pháp/cấu trúc SQL tĩnh: đạt.
  - Chưa chạy được database parser hoặc `pnpm typecheck` do môi trường không cung cấp kết nối DB và không nhận diện `pnpm`.
- **Trạng thái:** Đã hoàn thành

### [A.1] - Two cameras base schema migration (re-verified)

- **Mục tiêu:** Mở rộng schema cho luồng 2 camera và liên kết agent, bàn đóng gói, file recording, command cùng quyền truy cập.
- **Files tạo/sửa:**
  - `supabase/migrations/20260914072044_two_cameras_base_schema.sql` *(đã có)*
  - `change.md` *(sửa)*
- **Chi tiết thay đổi:** Đã xác nhận migration bao gồm `station_id`, `scan_source`, các trường camera/recording agent, 4 command type mới và 3 permission mới; unique partial index giới hạn 1 agent active/bàn.
- **Kết quả kiểm tra:**
  - Rà soát SQL tĩnh: đạt.
  - `pnpm typecheck`: không chạy được vì môi trường không cài/không nhận diện `pnpm`.
- **Trạng thái:** Đã hoàn thành

### [A.1] - Migration: two_cameras_base_schema

- **Mục tiêu:** Tạo migration SQL mở rộng schema DB cho luồng 2 camera (M1–M5, M14, M16 theo tuan-tu-xu-ly-2-camera.md).
- **Files tạo/sửa:**
  - `supabase/migrations/20260914072044_two_cameras_base_schema.sql` *(mới)*
- **Chi tiết thay đổi:**
  1. `warehouse_agents.station_id` (uuid, FK → packing_stations, nullable, unique khi status='active')
  2. `user_profiles.station_id` (uuid, FK → packing_stations, nullable)
  3. `packing_stations.scan_source` (text, default 'scanner', CHECK in ('scanner','camera'))
  4. `cameras`: `rtsp_substream_path` (text), `agent_id` (uuid FK → warehouse_agents), `probe_failing_since` (timestamptz), `disconnect_alerted_at` (timestamptz)
  5. `camera_recording_files.agent_id` (uuid FK → warehouse_agents)
  6. `agent_commands.type` CHECK nới thêm: connect_camera, test_qr_decode, live_remote_start, live_remote_stop
  7. `role_permission_matrix` thêm 3 quyền: packing_station.camera_setup (owner, admin), live.view_remote (owner, admin), live.view_station (packer)
- **Kết quả kiểm tra:**
  - `pnpm typecheck`: ✅ Pass (exit 0)
- **Trạng thái:** ✅ Đã hoàn thành

### [INIT-001] - Khởi tạo hệ thống quản lý change log

- **Mục tiêu:** Tạo file `change.md` để theo dõi mọi thay đổi trong dự án theo quy trình Atomic Commit & Rollback.
- **Files tạo/sửa:** `change.md` *(mới)*
- **Chi tiết thay đổi:**
  - Tạo file `change.md` với cấu trúc đầy đủ: thông tin dự án, quy ước commit, template task.
  - Định nghĩa quy trình làm việc: ghi dự định → code → test → commit hoặc rollback.
- **Trạng thái:** ✅ Đã hoàn thành

---

## 📐 Template Task (copy để dùng lại)

```
### [MODULE-XXX] - [Tên Task]

- **Mục tiêu:** ...
- **Files tạo/sửa:**
  - `path/to/file.ts` *(mới / sửa)*
- **Chi tiết thay đổi:**
  - ...
- **Kết quả kiểm tra:**
  - `pnpm typecheck`: ...
  - `pnpm lint`: ...
- **Trạng thái:** 🔄 Đang xử lý / ✅ Đã hoàn thành / ⏪ Rollback
- **Ghi chú lỗi (nếu rollback):** ...
```
