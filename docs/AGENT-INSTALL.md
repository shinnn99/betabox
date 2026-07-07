# Cài đặt Warehouse Agent lên máy kho

> ⚠️ **OUTDATED 2026-07-07** — hướng dẫn cũ pre-installer.
>
> Từ v0.2.0+ dùng installer đóng gói `.iss`. Xem hướng dẫn hiện tại tại:
> **`warehouse-agent/CACH-CAI-KHACH.md`**
>
> Installer tự làm:
> - Cấu hình NTP (w32time) → không cần bước copy PowerShell tay.
> - Cài Windows Service qua NSSM → không cần `sc create` tay.
> - Prefill wizard từ `.env` cũ khi upgrade in-place (giữ AGENT_SECRET).
> - Copy `ffmpeg.exe` + `ffprobe.exe` bundled.
>
> Doc này giữ chỉ để tra cứu lịch sử. Ưu tiên dùng installer.

Nếu bắt buộc cài tay (VD máy không cài được installer, môi trường lock down),
xem history git commit `aeb3b9e` (fix installer stop service ssInstall + prefill).
