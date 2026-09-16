# src/lib/station

Folder nay chua luat thoi gian va cau thong bao cho ban dong goi.

Vai tro chinh:

- `order-timeout.ts`: tinh tran thoi gian dong mot don va moc canh bao. Ham thuan, co test.
- `force-stop-expired-orders.ts`: cuong che chot cac don da qua tran (ghi DB).
- `announcements.ts`: kho cau thong bao hien toast va cau doc thanh tieng.

Nhung diem da xu ly:

- Tran cung 180s phai bang `MAX_CLIP_DURATION_SECONDS` trong `src/lib/order-proof/clip-window.ts`. Doi mot ben se tao ra khoang thoi gian khong co video tuong ung.
- `max_order_seconds` cua kho la tang NGHIEP VU (danh dau don bat thuong), con tran o day la tang KY THUAT cua video. Kho cau hinh 600s van bi keo ve 180s khi chot video.
- Don bi cuong che dung ghi `timing_status='capped_timeout'` (gia tri da co, `clip-window.ts` da xu ly dung) va `timing_note='auto_stopped_timeout'` de phan biet voi capped_timeout do quet ma ke.
- Update luon kem `.eq("timing_status","open")` nen hai tien trinh (poll man hinh ban + heartbeat agent) goi cung luc thi chi mot cai an row.

Nguyen tac bao tri:

- Cau chu trong `announcements.ts` da duoc nghiep vu chot; doi phai hoi lai va sua test `tests/station-order-timeout.test.ts`.
- Moi thong bao co hai dang: `message` (toast, co ma don de tra cuu) va `speech` (doc len, ngan, khong doc ma dai).
- `id` cua thong bao phai doi khi trang thai doi, neu khong client se khong doc lai.
