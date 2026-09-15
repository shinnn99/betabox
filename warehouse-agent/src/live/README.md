# warehouse-agent/src/live

Folder nay chua MediaMTX relay local cho live stream.

Vai tro chinh:

- Tao path MediaMTX an toan tu camera code.
- Ghi file config runtime cho MediaMTX.
- Dua RTSP source vao process con qua environment variable de config file khong chua credential.
- Restart MediaMTX khi danh sach camera/path thay doi.

Nhung diem da xu ly trong luong 2-camera:

- Ho tro overview va sub/QR stream cho tung camera.
- Bat WebRTC/WHEP tren localhost de dashboard xem live.
- Redact credential trong log MediaMTX.

Nguyen tac bao tri:

- Khong ghi RTSP URL co userinfo vao file config.
- Khong expose MediaMTX ra public network neu chua co auth/reverse-proxy rieng.
- `relayPathName` co tinh on dinh; doi format se lam hong URL WHEP dang luu/hien thi.
