# src/lib/live

Folder nay la tang helper cho live stream station tren cloud.

Vai tro chinh:

- Kiem tra quyen xem live theo user/station/admin.
- Tao danh sach stream theo station va vai tro camera.
- Tra ve URL WHEP local/remote cho UI dashboard.

Nhung diem da xu ly trong luong 2-camera:

- `station-access.ts` tach quyen admin va tai khoan duoc gan vao ban.
- `station-streams.ts` gom camera overview + QR thanh payload cho live layout.

Nguyen tac bao tri:

- Khong dua mat khau camera len browser.
- Browser chi nhan URL WHEP da duoc agent/MediaMTX expose, khong nhan RTSP goc.
- Khi them transport remote, giu cung contract camera role de UI khong can biet nguon stream.
