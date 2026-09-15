# src/lib/camera

Folder nay chua logic cloud-side cho camera:

- Tao RTSP URL tu IP/port/path/username/password.
- Ma hoa/giai ma password camera truoc khi luu hoac dung tam thoi.
- Probe/test stream bang FFmpeg/FFprobe.
- Quan ly camera service, online state, codec warning va recording path.
- Ho tro setup camera cho packing station ma van giu credential di qua backend/agent theo luong cu.

Nhung diem da xu ly trong luong 2-camera:

- `station-setup.ts` gan camera vao ban dong goi va xac dinh vai tro camera.
- `rtsp.ts` build URL va che toan bo RTSP userinfo khi log.
- `ffmpeg.ts` gom tat ca lenh FFmpeg cloud-side va khong tra stderr raw co credential ra client.
- `recording-service.ts`/`recording-paths.ts` phuc vu API start/stop/status recording.

Nguyen tac bao tri:

- Khong hardcode username/password camera trong code, env, README hoac log.
- Neu can log RTSP URL, bat buoc di qua `maskRtspUrl`.
- Khong dua UI-only state vao folder nay; day la tang nghiep vu/server-side.
