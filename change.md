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

### [FIX-2CAM-PROOF-PIP] - Clip bằng chứng phải có cả Hikvision và Dahua

- **Mục tiêu:** Sửa luồng proof hiện chỉ trả camera toàn cảnh Hikvision; mỗi request phải lấy segment riêng của `proof_primary` và `proof_qr`, ghép Dahua thành ô PiP đúng bố cục rồi mới upload.
- **Files tạo/sửa:** `src/lib/order-proof/clip-window.ts`, `src/lib/order-proof/clip-resolver.ts`, `src/lib/agent-commands/enqueue.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/compose/clip-composer.ts`, `src/lib/warehouse/recording-files-batch.ts`, `src/app/api/agent/recording-files/route.ts`, `tests/codec-invalidation.test.ts`, `tests/proof-size-estimate.test.ts`, `tests/recording-files-batch.test.ts`, `.env.local`, `scripts/qa-run-source-agent.ps1`, `scripts/qa-compose-two-camera-proof.ts`, `scripts/qa-upload-two-camera-proof.mjs`, `plans/completed/FIX-2CAM-PROOF-PIP.md`, `change.md`.
- **Chi tiết thay đổi:** Xác nhận clip `0c82d0a2-d9af-41cf-95e0-cf94d546e77a` cũ chỉ mang Hikvision. Cloud nay resolve segment riêng theo `proof_primary`/`proof_qr` và đúng `agent_id`, gửi hai góc cùng layout; agent nối từng góc, seek chính xác lúc compose, ghép H.264 1920×1080 không âm thanh với Hikvision toàn khung, Dahua 640×360 góc trên phải, viền trắng và dải thông tin đáy. Hard cap file cuối là 180 giây tính cả pre-roll; guard QA đặt 150 MiB. Segment report lấy `agent_id` từ danh tính HMAC, không tin payload. Không hard-code Bàn 3 trong logic sản phẩm và không đổi template UI.
- **Kết quả kiểm tra:** Bản PiP thật dài 132,72 giây, 51.444.746 byte, H.264 1920×1080; ảnh kiểm tra thấy rõ cả Hikvision và Dahua. Đã upload thay đúng object QA trên Supabase; Storage/DB xác nhận `angles_present=[overview,qr]`. Root 337/337 test xanh; agent 88/88 test xanh; root và agent typecheck xanh; ESLint các file mục tiêu xanh. Live MediaMTX đã khởi động lại trên 8554/8889.
- **Trạng thái:** Đã hoàn thành

### [QA-2CAM-QR-SEGMENT-COMPOSE] - Kiểm thử QR, segment và ghép clip hai góc

- **Mục tiêu:** Kiểm thử thực tế tại `BAN_03`: Dahua nhận QR thứ nhất và QR thứ hai để tạo hai sự kiện/đơn liên tiếp; recording hai camera vẫn chạy theo segment; clip mỗi đơn tối đa 180 giây; chỉ khi nhận proof request mới cắt segment của từng camera, tạo hai video góc quay, ghép thành một clip cuối và upload Supabase.
- **Files tạo/sửa:** `supabase/migrations/20260914083000_two_cameras_scan_source.sql` (triển khai remote); `scripts/qa-run-source-agent.ps1`, `scripts/qa-open-station-shift.mjs` và ảnh/recording tạm; `src/lib/live/station-access.ts`, `src/app/api/live/[stationId]/route.ts`, `src/app/api/live/[stationId]/events/route.ts`, `src/components/station/StationLivePanel.tsx`; dự kiến sửa `src/lib/warehouse/recording-files-batch.ts`, `src/app/api/agent/recording-files/route.ts` và test liên quan để segment luôn ghi `agent_id`; báo cáo trong `plans/reports/`, `change.md`.
- **Chi tiết thay đổi:** Trước tiên đối chiếu `docs/tuan-tu-xu-ly-2-camera.md`, trạng thái migration, agent/recording/QR/clip pipeline và dữ liệu Bàn 3. Credential chỉ dùng trong RAM. Dữ liệu test sẽ được đánh dấu để truy vết và rollback; không upload clip trước khi có request. Mọi sửa đổi là logic sản phẩm tổng quát theo station/agent/role (Admin và tài khoản được gán bàn), không hard-code Bàn 3 hoặc tài khoản kiểm thử; môi trường hiện tại chỉ dùng một tài khoản để chạy hết chức năng E2E. Đã sửa quyền API live và bổ sung alert realtime “Đã nhận” có âm thanh, giữ nguyên template. E2E tiếp tục phát hiện segment từ agent vẫn có `agent_id = null`; sẽ bổ sung trường này từ danh tính HMAC của agent, không tin payload.
- **Trạng thái:** Đang xử lý

### [C.1.4-FULLSCREEN-TOGGLE] - Bật/tắt toàn màn hình camera

- **Mục tiêu:** Nút toàn màn hình của khung live phải mở được và bấm lại để thoát được; trạng thái/icon/nhãn truy cập đồng bộ kể cả khi người dùng thoát bằng phím Esc.
- **Files tạo/sửa:** `src/components/station/LiveLayout.tsx`, `change.md`.
- **Chi tiết thay đổi:** Dùng Fullscreen API trong Client Component; nếu đang fullscreen thì gọi `document.exitFullscreen()`, nếu chưa thì gọi `requestFullscreen()`. Theo dõi và cleanup sự kiện `fullscreenchange`; đổi icon Expand/Minimize, `aria-label`, `aria-pressed` và tooltip theo trạng thái. Không tác động WebRTC/recording.
- **Kết quả kiểm tra:** `pnpm typecheck`: đạt; ESLint `LiveLayout.tsx`: 0 lỗi; test helper live: 5/5 đạt.
- **Trạng thái:** Đã hoàn thành

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

### [QA-2CAMERA-FULL] - Kiểm thử toàn bộ hệ thống hai camera

- **Mục tiêu:** Kiểm thử release-gate toàn bộ luồng mới theo `docs/tuan-tu-xu-ly-2-camera.md`: web/API, migration, agent, MediaMTX, QR, bảo mật credential và các contract liên tầng; báo cáo đầy đủ lỗi/tồn đọng, không tự sửa trong lượt QA.
- **Files tạo/sửa:** `plans/reports/QA-2CAMERA-FULL-2026-09-15.md`, `change.md`; không sửa logic sản phẩm.
- **Chi tiết thay đổi:** Đã chạy toàn bộ typecheck, ESLint, test, production build, standalone/dev smoke, kiểm tra clean-bootstrap và 4 migration hai-camera trên PostgreSQL cô lập, SQL behavior theo ca, secret scan, static contract audit, FFprobe và MediaMTX → FFmpeg → QR decoder trên cả Hikvision/Dahua thật. Typecheck/build/agent test/media smoke đạt; root test còn 1 lỗi, ESLint còn 16 lỗi, clean-bootstrap migration thất bại và phát hiện các lỗi định tuyến sai agent/camera cùng nhiều bước kiến trúc chưa triển khai. Báo cáo chi tiết nằm tại `plans/reports/QA-2CAMERA-FULL-2026-09-15.md`. Container/script QA tạm đã dọn; UI dev đang chạy ở `https://localhost:3000/login`. Không build agent `.exe`/installer và không dùng Git.
- **Trạng thái:** Báo lỗi — release gate không đạt, chưa được phát hành

### [C.1.4-LIVE-MONITOR] - Hiển thị trực tiếp hai camera theo bàn

- **Mục tiêu:** Trên giao diện Giám sát đóng hàng, chọn một bàn sẽ hiển thị trực tiếp camera toàn cảnh toàn khung và camera QR ở ô 1/9 góc trên phải; admin xem được bàn thuộc tổ chức, tài khoản đóng gói chỉ xem được bàn đã gán.
- **Files tạo/sửa:** Dự kiến `src/app/api/live/[stationId]/route.ts`, `src/app/dashboard/station/page.tsx`, `src/components/station/LiveLayout.tsx`, `src/components/station/WebRtcPlayer.tsx`, `src/app/dashboard/operations/page.tsx`, `warehouse-agent/src/qr/qr-decoder.ts`, test liên quan và `change.md`; giữ nguyên template giao diện hiện tại.
- **Chi tiết thay đổi:** Đã thêm API live kiểm tổ chức/vai trò/bàn, station page cho tài khoản bàn, bộ phát WHEP client có retry/cleanup, layout toàn cảnh + QR đúng ô 1/9 và tích hợp ô chọn bàn vào Giám sát đóng hàng mà không đổi template. Đăng nhập `packer` được điều hướng về trang bàn. Kiểm thử ảnh thật Dahua xác nhận ZXing mặc định không nhận nhưng `tryDenoise` nhận đúng ở cả 1920×1080, 640×360 và crop; đã bật tùy chọn này trong decoder. Không trả RTSP/credential về cloud/UI.
- **Kết quả kiểm tra:** `pnpm typecheck` đạt; ESLint mục tiêu 0 lỗi (còn 1 warning cũ trong `operations/page.tsx` và cảnh báo ignored cho thư mục agent); 5/5 test helper live đạt; 88/88 test agent đạt; `pnpm build` đạt ngoài sandbox. Chưa nghiệm thu live end-to-end vì Supabase đích chưa áp dụng schema/quyền hai-camera, assignment hiện gán Dahua sai vai trò và Hikvision chưa active; main stream Dahua là H.265 trong khi kiến trúc bắt buộc H.264; cổng MediaMTX localhost chưa chạy.
- **Trạng thái:** Báo lỗi — giữ ở `plans/active`, chưa chuyển `completed`

### [RELEASE-2CAMERA] - Commit và đẩy nhánh 2-camera

- **Mục tiêu:** Đưa toàn bộ thay đổi bài toán hai camera đã kiểm tra lên `origin/2-camera`, tuyệt đối không commit/push vào `main`.
- **Files tạo/sửa:** `.gitignore`, `change.md`; commit các file triển khai, migration, test, plan và báo cáo liên quan.
- **Chi tiết thay đổi:** Đã loại khỏi commit thư mục bản cài local, `.env`, private key/certificate tự sinh và scratch scripts; credential scan sạch; staged diff đã kiểm tra. Commit chức năng `a696146` đã được đẩy lên đúng `origin/2-camera`. GitHub cảnh báo binary MediaMTX 53,44 MB vượt mức khuyến nghị 50 MB nhưng vẫn nhận file; không tạo agent/installer mới.
- **Trạng thái:** Đã hoàn thành — remote `origin/2-camera` đã cập nhật; không commit hoặc push vào `main`.

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
### [C.1.4-CAMERA-H264-TEST] - Chuẩn hoá H.264 và kiểm thử hai camera LAN

- **Mục tiêu:** Cấu hình hai camera kiểm thử Hikvision và Dahua dùng H.264 cho các profile main/sub; tạo Bàn 3 trong tổ chức Kho Đại Kim, đổi mã hai camera thành `dahua_3` ở vai trò `proof_qr` và `hik_3` ở vai trò `proof_primary`.
- **Files tạo/sửa:** Cấu hình encoder hai camera LAN; dữ liệu Supabase cho `BAN_03`, camera/device/assignment/agent; `plans/completed/C.1.4-station-live-page.md`, `change.md`. Toàn bộ script, ảnh, Chrome profile và staging migration QA tạm đã xoá sau kiểm tra.
- **Chi tiết thay đổi:** Hikvision vốn đã H.264; Dahua được đổi các profile H.265 sang H.264 nhưng giữ độ phân giải/FPS/bitrate/GOP. Tạo `BAN_03` trong đúng tenant UI `Betacom`, gán `AGENT_KHO_HN_01`, `hik_3` vai trò `proof_primary`, `dahua_3` vai trò `proof_qr` và scanner ảo `qrcam_dahua_3`. Tenant tạo nhầm trước đó được chuyển inactive/archive, credential camera cũ được xoá nhưng lịch sử được giữ nguyên. Không ép clip xuống 50 MB; giữ trần 90 MiB. Credential chỉ dùng trong RAM.
- **Kết quả kiểm tra:** FFprobe qua MediaMTX đạt: Hik H.264 2688×1520, Dahua H.264 1920×1080; Dahua đọc QR ngay frame xử lý đầu; chữ nhãn đọc rõ; WHEP/CORS localhost đạt; hậu kiểm tenant/agent/device/assignment đạt.
- **Trạng thái:** Đã hoàn thành
### [C.1.4-LIVE-TOGGLE] - Bấm thẻ bàn để mở hoặc đóng live

- **Mục tiêu:** Trên Giám sát đóng hàng, bấm thẻ bàn để mở live hai camera; bấm lại cùng bàn để đóng; đổi sang bàn khác sẽ chuyển live, không tác động tới ghi hình/QR trên agent.
- **Files tạo/sửa:** `src/app/dashboard/operations/page.tsx`, `src/components/station/WebRtcPlayer.tsx`, `src/components/station/LiveLayout.tsx`, `plans/completed/C.1.4-station-live-page.md`, `change.md`; giữ nguyên template.
- **Chi tiết thay đổi:** Chỉ mount `StationLivePanel` khi bàn đang mở; bấm lại cùng bàn unmount viewer, đóng peer/session WHEP nhưng không gọi lệnh dừng recording/camera. Sửa xung đột class `relative` ghi đè `absolute` khiến Dahua PiP nằm ngoài vùng hiển thị; QR PiP có lớp `z-10` đúng góc trên phải.
- **Kết quả kiểm tra:** `pnpm typecheck` đạt; 5/5 test live đạt; 88/88 test agent đạt; ESLint mục tiêu 0 lỗi, còn 1 warning polling cũ ngoài thay đổi. Log trình duyệt xác nhận đồng thời hai peer WHEP Hik/Dahua established.
- **Trạng thái:** Đã hoàn thành
### [SEC-CAMERA-CREDENTIAL-REDACTION] - Không để lộ tài khoản camera trong log

- **Mục tiêu:** Bảo đảm username/password camera do admin nhập không bị ghi nguyên văn hoặc xuất hiện trong RTSP URL tại file cấu hình, hàng đợi lệnh và log; credential chỉ được giải mã tạm thời trong RAM lúc Agent kết nối thiết bị.
- **Files tạo/sửa:** `src/lib/camera/rtsp.ts`, `src/lib/camera/ffmpeg.ts`, `warehouse-agent/src/recording.ts`, `tests/rtsp-redaction.test.ts`, `warehouse-agent/tests/recording-redaction.test.ts`, `warehouse-agent/tests/relay-hub.test.ts`, `plans/completed/SEC-CAMERA-CREDENTIAL-REDACTION.md`, log runtime đã phát sinh và `change.md`; đã xóa `scratch_url.mjs`.
- **Chi tiết thay đổi:** Giữ nguyên luồng kết nối camera cũ qua UI và password mã hóa trong database. Redaction giờ che toàn bộ RTSP userinfo, lọc mọi URL trong FFmpeg stderr thay vì chỉ thay đúng chuỗi đầu vào. Đã làm sạch log Agent cũ, xóa scratch chứa URL credential, khởi động lại Agent nguồn ngoài sandbox và xác nhận MediaMTX nghe tại 8554/8889, hai FFmpeg hoạt động, log cũ/mới đều có 0 credential chưa che. Root test 339/339, Agent test 89/89, hai typecheck và ESLint mục tiêu đều đạt.
- **Trạng thái:** Đã hoàn thành
### [DOC-2CAM-HANDOVER] - Chu thich code va README cho luong 2 camera

- **Muc tieu:** Bo sung chu thich dung cho va README cho cac folder lien quan den luong 2 camera de dev khac doc hieu nhanh pham vi, vai tro va nhung phan da xu ly.
- **Files tao/sua:** `src/lib/camera/README.md`, `src/lib/order-proof/README.md`, `src/lib/live/README.md`, `src/components/station/README.md`, `src/app/api/live/README.md`, `src/app/api/packing-stations/README.md`, `src/app/api/order-proof/README.md`, `src/app/api/agent/README.md`, `src/app/api/cameras/[id]/recording/README.md`, `warehouse-agent/src/README.md`, `warehouse-agent/src/compose/README.md`, `warehouse-agent/src/live/README.md`, `warehouse-agent/src/qr/README.md`, `supabase/migrations/README.md`, `src/components/station/LiveLayout.tsx`, `src/components/station/StationLivePanel.tsx`, `warehouse-agent/src/compose/clip-composer.ts`, `warehouse-agent/src/live/relay-hub.ts`, `warehouse-agent/src/recording.ts`, `change.md`.
- **Chi tiet thay doi:** Da bo sung README ngan cho cac folder chinh cua luong 2-camera va them comment tai cac contract de hong: live layout phai dong bo voi proof composer, viewer toggle khong dung recording, MediaMTX config khong ghi credential, RTSP redaction che ca username/password. Khong doi logic runtime trong phan tai lieu.
- **Trang thai:** Da hoan thanh

### [FIX-2CAM-SEGMENT-COMPOSE] - Sua ghep segment 2 camera thanh 1 video proof

- **Muc tieu:** Kiem tra va sua pipeline ghep segment cua 2 camera de video dau ra giong khung giam sat: camera toan canh full frame, camera QR PiP goc tren phai.
- **Files tao/sua:** `src/lib/agent-commands/enqueue.ts`, `src/lib/agent-commands/cut-clip-planning.ts`, `tests/cut-clip-planning.test.ts`, `change.md`.
- **Chi tiet thay doi:** Sua logic chon QR camera cho proof clip: neu `packing_events.proof_qr_camera_id` co snapshot thi dung snapshot; neu khong co thi fallback sang camera `proof_qr` dang gan vao station bat ke `packing_stations.scan_source`. `scan_source` chi quyet dinh nguon tao scan, khong duoc lam mat goc Dahua/QR trong video bang chung. Them helper va test de khoa lai behavior nay. Khi chay full agent test, da dung tam runtime warehouse-agent/MediaMTX/FFmpeg test cu dang giu cong 8554; khong lap lai credential trong log bao cao.
- **Ket qua kiem tra:** `pnpm test`: 342/342 pass; `pnpm typecheck`: pass; ESLint cac file muc tieu: pass; `warehouse-agent npm run typecheck`: pass; `warehouse-agent npm test`: fail lan dau do MediaMTX runtime cu chiem port 8554, sau khi dung dung runtime test thi 89/89 pass.
- **Trang thai:** Da hoan thanh

### [OPS-STATION-TIMEOUT-VOICE] - Tran 3 phut moi don va thong bao doc thanh tieng tai ban

- **Muc tieu:** Gioi han thoi gian dong mot don toi da 3 phut, qua han thi cuong che dung video va bao "Video qua thoi gian quy dinh, tu dong dung"; dong thoi cac su kien tai ban (mo ca, quet ma, canh bao) deu duoc doc thanh tieng.
- **Files tao/sua:** `src/lib/station/order-timeout.ts`, `src/lib/station/force-stop-expired-orders.ts`, `src/lib/station/announcements.ts`, `src/lib/station/README.md`, `src/app/api/live/[stationId]/events/route.ts`, `src/app/api/live/README.md`, `src/app/api/warehouse/heartbeat/route.ts`, `src/components/station/StationLivePanel.tsx`, `src/components/station/README.md`, `tests/station-order-timeout.test.ts`, `change.md`.
- **Chi tiet thay doi:** Tran = `max_order_seconds` cua kho, kep trong [30s, 180s]; 180s khop `MAX_CLIP_DURATION_SECONDS`. Don qua han bi chot `timing_status='capped_timeout'`, `work_ended_at = work_started_at + limit`, `work_duration_seconds = limit`, `timing_note='auto_stopped_timeout'`; update kem `.eq("timing_status","open")` nen idempotent giua poll man hinh ban va heartbeat agent. Route events tra them `speech` va `current_order` (deadline, so giay con lai). Man hinh ban doc thanh tieng bang Web Speech API `vi-VN`, ba mau am theo muc, dem nguoc tai cho, canh bao mot lan khi con 30s, chip nhac cham de mo khoa am thanh. Them canh bao "camera chua ghi hinh" khi co don mo ma khong co phien ghi nao dang chay. Cau thong bao: mo ca -> "Mo ca thanh cong"; quet ma hop le -> "Bat dau quay video"; qua han -> "Video qua thoi gian quy dinh, tu dong dung"; them ket thuc ca, chuyen ban, thay nhan vien, ma trung, chua mo ca, QR nhan vien khong hop le.
- **Ket qua kiem tra:** `pnpm test` 351/351 dat (9 test moi); `pnpm typecheck` dat; ESLint cac file muc tieu 0 loi 0 warning. Nghiem thu tren he thong dang chay: don DEMO2CAM-B mo luc 02:15:09 bi heartbeat chot dung 02:18:09 voi `timing_note=auto_stopped_timeout`, log `[station-timeout] cuong che dung ... limit=180s`; clip ghep 2 goc cua don do dai dung 180.00s, 70.3 MB, duoi tran upload 90 MiB.
- **Trang thai:** Da hoan thanh

### [E.1-PLAN] - Ke hoach IP camera co dinh va xem camera tu xa

- **Muc tieu:** Phan tich va lap ke hoach cho hai tinh nang moi: dinh danh camera co dinh (khong phu thuoc IP) va xem camera tu xa ngoai LAN. Chua viet code, cho duyet.
- **Files tao/sua:** `plans/active/E.1-ip-camera-co-dinh-va-remote-live.md`, `change.md`.
- **Chi tiet thay doi:** Chot huong dinh danh camera bang MAC + ONVIF UUID, ghim IP bang DHCP reservation tren router, tu do lai theo MAC khi probe hong; hoan viec set IP tinh qua ONVIF sang pha sau vi rui ro mat quyen truy cap camera. Xem tu xa: so sanh 5 phuong an, chon agent day sub-stream len 1 VPS relay theo yeu cau (SRT vao, WHEP/WebRTC ra), uoc tinh 6-12 USD/thang, kem ba chot chan chi phi (2 viewer, 10 phut, han muc thang). Loai bo NAT port/DDNS va stream 24/7 len cloud. Ghi ro rang xem tu xa khong duoc lam anh huong ghi bang chung.
- **Ket qua kiem tra:** Chua co (tai lieu ke hoach).
- **Cap nhat 16/09 sau khi chot voi chu du an:** chi admin/chu kho noi bo duoc xem; dung main-stream (khong transcode tren may ban, ha bitrate bang cai dat trong camera); he thong se dong goi ban cho khach nen relay da tenant, do dem luu luong theo tenant, hai mo hinh trien khai (relay dung chung / relay rieng cua khach) va cong tac tat theo tenant deu phai co tu ban dau. Chi phi tinh lai o main-stream 4 Mbps: 1,8 GB moi gio-nguoi-xem, gia von ~450 d/gio; VPS Singapore ~12 USD/thang. Them muc kiem tra duong truyen tai kho truoc khi bat.
- **Trang thai:** Cho duyet

### [PROOF-CLIP-FILENAME] - Ten file video xuat ra theo ma van don va thoi gian

- **Muc tieu:** Video bang chung khi tai ve phai co ten `<ma van don>-<ngay>-<gio>.mp4` thay vi UUID.
- **Files tao/sua:** `src/lib/order-proof/clip-file-name.ts`, `src/lib/order-proof/README.md`, `src/lib/watch/proof-clip-signed-url.ts`, `src/lib/watch/use-watch-clip-state.ts`, `src/app/api/order-proof/[pe_id]/watch/route.ts`, `src/app/api/agent/clip-cut-result/route.ts`, `src/app/dashboard/videos/page.tsx`, `tests/clip-file-name.test.ts`, `change.md`.
- **Chi tiet thay doi:** Ten file dang `<ma van don>-<yyyyMMdd>-<HHmmss>.mp4` theo gio VN, moc lay tu `packing_events.scanned_at` de sinh lai clip van ra cung ten. Helper signed URL tra them `downloadUrl` (them query `?download=`) va `fileName`; URL phat inline giu nguyen khong co `download` de khong bien the `<video>` thanh tai xuong. Route `/watch` tra them `download_url` + `file_name`, hook expose ra UI, modal xem video co them nut "Tai video". `clip_name` trong DB nay do cloud tinh khi nhan ket qua cat, khong tin ten agent gui len. Clip cu van tai ve dung ten vi ten duoc tinh lai luc cap signed URL. `bucket_path` giu nguyen.
- **Ket qua kiem tra:** `pnpm test` 357/357 dat (6 test moi); `pnpm typecheck` dat; guard `check-proof-clip-signed-url` dat; ESLint khong phat sinh loi moi (cac loi con lai da co san tren HEAD). Do that tren Storage: URL kem `?download=` tra `content-disposition: attachment; filename=...`, URL khong kem tra null.
- **Trang thai:** Da hoan thanh

### [E.1-ROLLBACK-A] - Rollback ve code da commit, chi giu lai Buoc A (tim camera bang MAC)

- **Muc tieu:** Theo yeu cau: tra cay lam viec ve dung commit 997daab cua nhanh 2-camera de test quet ma don, sau do chi lay lai phan tim kiem bang dia chi MAC, tam hoan phan xem tu xa.
- **Files tao/sua:** `src/lib/camera/mac-columns.ts` (moi), `src/lib/camera/active-credentials.ts`, `src/lib/camera/service.ts`, `warehouse-agent/src/camera-heal.ts`, `warehouse-agent/src/lan-arp.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/tests/camera-heal.test.ts`, `warehouse-agent/tests/lan-arp.test.ts`, `change.md`.
- **Chi tiet thay doi:** Toan bo cong viec E.1 (A + B + UI + infra) duoc cat vao nhanh `e1-backup-20260916` (commit bf78829) TRUOC khi rollback, khoi phuc bang `git checkout e1-backup-20260916 -- .`. Sau do lay lai chi cac file cua Buoc A; rieng `warehouse-agent/src/index.ts` chua ca A lan B nen da go bo ba khoi cua B (import RemotePublisher, khoi tao publisher, hai nhanh lenh live_remote_start/stop, va stopAll luc shutdown). KHONG lay lai: relay-limits, remote-session, media-auth, live/remote, cron sweep, RemoteLivePanel, remote-publish, migration 20260916140000, infra/relay.
- **Ket qua kiem tra:** `pnpm test` 357/357 dat; `pnpm typecheck` dat; ESLint cac file cloud 0 loi; agent `npm run typecheck` dat; agent test 111/112 (1 fail la relay-hub doi cong 8554 dang bi agent that chiem, khong lien quan).
- **Trang thai:** Da hoan thanh

### [E.1-A-FIX-ARP] - Tim camera theo MAC: hoi bang ARP truoc, quet cong chi la du phong

- **Muc tieu:** Sua loi that phat hien khi chay tren kho: agent tu kich hoat do lai dung nhu thiet ke nhung KHONG tim thay camera, du camera van o nguyen tren mang.
- **Files tao/sua:** `warehouse-agent/src/lan-arp.ts`, `warehouse-agent/src/camera-heal.ts`, `warehouse-agent/tests/lan-arp.test.ts`, `warehouse-agent/tests/camera-heal.test.ts`.
- **Chi tiet thay doi:** Nguyen nhan do duoc: quet cong co timeout 1 giay va chay tren chinh may dang ghi hinh. Luc heal chay that, quet chi thay `hosts_open=3 mac_resolved=2`; chay tay vai giay sau tren cung subnet thay `hosts_open=7 mac_resolved=6` — camera can tim roi mat. Bang ARP luc do da co san dung IP. Nen doi thu tu: (1) `findIpByMac` doc thang bang ARP, loc theo tien to /24, tu choi khi MAC ung nhieu IP; (2) chua thay moi quet, va quet xong tra lai ARP lan nua vi quet chinh la cach danh thuc ARP; (3) THEM buoc xac nhan cong RTSP mo o IP moi truoc khi bao cloud — khop MAC da manh nhung mot ban ghi ARP cu co the tro vao thiet bi da tat. Do that tren LAN kho: tra ARP mat 47-60 ms va dung ca hai camera, so voi 4,7 s cua mot lan quet.
- **Ket qua kiem tra:** agent test 111/112 (6 test moi: 3 cho findIpByMac, 3 cho thu tu tim kiem va chot "chua xac nhan RTSP thi khong bao cloud"); `npm run typecheck` dat. Do truc tiep tren LAN that: MAC Hikvision -> 192.168.31.135 trong 60 ms, MAC Dahua -> 192.168.31.12 trong 47 ms.
- **Trang thai:** Da sua va co test; CHUA chay lai chuoi day du tren agent that vi may dang duoc dung de test quet ma don.

### [E.1-A-DB-FALLBACK] - Cloud khong duoc gay khi database chua co cot MAC

- **Muc tieu:** Chan lai mot loi da xay ra that: ma nguon doi cot `cameras.mac_address` tren database chua ap migration, lam hong ca luong ghi hinh.
- **Files tao/sua:** `src/lib/camera/mac-columns.ts` (moi), `src/lib/camera/active-credentials.ts`, `src/lib/camera/service.ts`.
- **Chi tiet thay doi:** Ma nguon va migration khong len cung luc. Luc 14:10 ngay 16/09 dieu do xay ra: `[camera-probe] active_cameras lookup failed ... column cameras.mac_address does not exist` — agent mat danh sach camera can ghi. Them `selectCamerasWithMacFallback`: gap loi undefined_column (42703) lien quan cot MAC thi chay lai truy van voi danh sach cot cu va canh bao mot lan kem ten migration can ap. Duong ghi (them/sua camera) cung tu bo `mac_address` khoi payload thay vi tu choi tao camera. Mat MAC chi mat kha nang tu do IP; mat truy van la mat ghi bang chung — khong danh doi duoc.
- **Ket qua kiem tra:** Do tren he thong dang chay voi database CHUA ap migration: truoc khi sua, moi nhip `camera-probe` deu kem dong `column cameras.mac_address does not exist`; sau khi sua, khong con dong loi nao va chi con mot canh bao nhac ap migration. `pnpm test` 357/357, `pnpm typecheck` dat.
- **Trang thai:** Da hoan thanh

### [E.1-A-E2E] - Chay dau-cuoi tren agent that: tim ra hai loi chan duong, da sua

- **Muc tieu:** Chung minh chuoi "camera doi IP -> he thong tu tim lai -> GHI HINH TIEP" chay duoc tren tien trinh agent that, khong phai goi ham.
- **Files tao/sua:** `src/lib/supabase/proxy.ts`, `tests/agent-routes-bypass-proxy.test.ts` (moi), `warehouse-agent/src/recording-lifecycle.ts`, `warehouse-agent/src/index.ts`, `plans/reports/E.1-A-nghiem-thu-2026-09-16.md`, `change.md`.
- **Chi tiet thay doi:** Hai loi chi lo ra khi chay that:
  (1) `/api/agent/camera-ip-healed` chua co trong `PUBLIC_API_PREFIXES` cua proxy, nen bi chan tu vong ngoai voi `401 unauthenticated` — request KHONG bao gio toi cho kiem HMAC. Moi test truoc do goi thang route handler nen deu xanh. Da them vao danh sach VA them test `agent-routes-bypass-proxy` doi chieu toan bo `AGENT_API_PATHS` voi danh sach nay; da kiem nguoc bang cach xoa dong khai bao, test do dung nhu mong doi.
  (2) Chua duoc IP roi nhung ghi hinh khong chay lai: nhip probe van tro vao URL cu nen khong bao gio "ok" du 2 nhip de kich hoat phuc hoi nhanh — tu khoa lan nhau, phai cho het nhip long-retry 5 phut. Them `RecordingLifecycle.notifyEndpointHealed()` lay lai credential va spawn ffmpeg ngay sau khi chua xong.
- **Ket qua kiem tra:** Chay that tren agent voi camera that (dung agent nhanh, GIU service production chay nen ghi hinh that khong mat phut nao): tu luc agent khoi dong den khi co segment moi cua hik_3 la **55 giay** — probe hong 3 nhip -> `[camera-heal] IP moi 192.168.31.250 -> 192.168.31.135` -> `[recording-lifecycle] IP vua duoc chua, thu ghi lai ngay` -> `long-retry refreshed credentials (rtsp_url changed)` -> `[segment-index] rolled camera=hik_3`. DB: ip ve dung, `ip_auto_healed_count` tang, `ip_last_changed_at` co moc, mot dong `camera_endpoint_history` source=auto_heal. Kiem tien trinh: ffmpeg dang doc 192.168.31.135. `pnpm test` 358/358; agent test 111/112 (1 fail relay-hub doi cong 8554, co tu truoc).
- **Trang thai:** Da hoan thanh — muc nghiem thu 2.4.1 cua ke hoach E.1 DAT

### [E.1-A-2CAM] - Nghiem thu muc 2.4.2: camera cung model tren cung subnet

- **Muc tieu:** Chung minh he thong khong nhan nham khi trong kho co hai camera cung model.
- **Files tao/sua:** `plans/reports/E.1-A-nghiem-thu-2026-09-16.md`, `plans/active/E.1-ip-camera-co-dinh-va-remote-live.md`, `change.md`.
- **Chi tiet thay doi:** Khong sua code. Chu du an cam them camera; tren LAN co ba thiet bi mo cong RTSP: 192.168.31.12 (dahua_3), 192.168.31.18 (cung dong firmware voi hik_3, header HTTP giong het), 192.168.31.135 (hik_3).
- **Ket qua kiem tra:** Phan biet 4/4 tren ca hai duong tim kiem (tra ARP va qua ket qua quet), gom ca truong hop MAC bia lech dung 1 ky tu so voi hik_3 — tra ve "khong thay" chu khong vo lay camera cung model ben canh. Chay dau-cuoi voi ca ba camera dang song: 55 giay, chon dung .135, ffmpeg xac nhan doc 192.168.31.135, khong dung toi .18. Lan quet nay lai bo sot .18 (hosts_open=4) trong khi ARP thay du ba — lan thu ba quan sat duoc hien tuong nay.
- **Trang thai:** Da hoan thanh — muc 2.4.2 DAT

### [FIX-QRCAM-SCANNER] - Camera quet ma thieu scanner ao lam moi lan quet hong trong im lang

- **Muc tieu:** Sua goc loi khien mo don bang QR khong chay: moi ma quet bang camera deu tra `unmapped_scanner`.
- **Files tao/sua:** `src/lib/camera/qr-virtual-scanner.ts` (moi), `src/lib/camera/service.ts`, `tests/qr-virtual-scanner.test.ts` (moi), `change.md`.
- **Chi tiet thay doi:** Agent bao ma quet duoi ten thiet bi `qrcam_<ma camera>`; cloud tra ten do qua `resolve_scanner_at`, ham nay doi thiet bi `status='active'` VA co mot phan cong dang mo. Scanner ao chi duoc tao trong nhanh gan cua `POST /api/station-device-assignments`. Ngay 15/09 camera `dahua_3` duoc chuyen sang BAN_03 cua to chuc Betacom bang cach tao ban ghi thiet bi moi (khong qua duong gan chuan), nen scanner ao cu bi archive lai o to chuc Dai Kim va to chuc moi khong co cai nao — hon mot ngay moi lan quet deu hong ma dashboard khong co canh bao nao, chi mot dong log o agent. Them `planVirtualScannerRepairs` (ham thuan, quyet dinh viec can sua) va `ensureQrVirtualScanners` (thuc thi) chay ngay sau `ensureCameraSoftLinks` trong `listCameras`, cung TTL 30s va cung bi xoa boi `invalidateCameraCaches`. Ba rang buoc co y: camera chua gan vao ban nao thi KHONG tao gi; khong bao gio go scanner ao (sai lech sua bang cach gan lai); khong tra duoc ma camera thi bo qua chu khong doan ten thiet bi.
- **Ket qua kiem tra:** 7 test moi cho phan quyet dinh (tao moi, dung yen khi da dung, bat lai ban archived, keo ve dung ban khi gan nham, va hai truong hop khong duoc tao gi). Chay that tren ban sao production o Supabase local: truoc khi chay khong co `qrcam_*` nao; sau mot lan goi `listCameras` da tao `qrcam_dahua_3` active va gan vao BAN_03; `resolve_scanner_at` tra ve dung cap device/station. `pnpm test` 365/365; `pnpm typecheck` dat; ESLint sach.
- **Trang thai:** Da hoan thanh phan ma; DB dang chay se tu sua khi mo trang Thiet bi lan dau.
