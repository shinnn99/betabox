# Task D.1 — Hàng chờ video và ghép PiP

## Mục tiêu

1. Khi agent offline, lưu yêu cầu xem video; heartbeat online chuyển yêu cầu thành `cut_clip`.
2. Tạo `warehouse-agent/src/compose/clip-composer.ts`: nối segment bằng stream copy, đặt `-ss` trước `-i`, ghép QR PiP 640x360 tại `(1280,0)` trên video 1920x1080.

## Kiểm tra

Chỉ bắt đầu sau khi C.1 hoàn tất; chạy test/typecheck rồi chuyển sang `plans/completed/`.

## Kết quả audit 2026-09-14

Chưa hoàn thành. Thiếu resolver/payload hai góc, compose plan, encoder detection, font extraction, tích hợp pipeline `cut_clip`, progress/lease, trạng thái danh sách và download. Chờ C.1 hoàn tất trước khi xử lý.
