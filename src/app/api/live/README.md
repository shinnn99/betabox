# src/app/api/live

Folder nay chua API route cho live station.

Endpoint chinh:

- `GET /api/live/[stationId]`: tra camera overview/QR va WHEP URL cho station.
- `GET /api/live/[stationId]/events`: poll event moi nhat de UI hien toast/alert/doc tieng, kem `current_order` de dem nguoc tran thoi gian.

Nhung diem da xu ly trong luong 2-camera:

- API phan biet viewer admin va viewer duoc gan vao station.
- Payload tra ve theo role camera de UI render dung bo cuc.
- Route events KHONG doc bang log su kien rieng: no suy ra su kien tu trang thai that (lan quet QR nhan vien gan nhat, don gan nhat, don co bi cuong che dung khong).
- Route events cung la noi thuc thi tran thoi gian dong don: moi luot poll goi `forceStopExpiredOrders`. Heartbeat agent goi cung ham do de luat van chay khi khong ai mo man hinh ban.
- Canh bao "camera chua ghi hinh" chi kiem tra khi dang co don mo, de khong them query moi 1.5s luc ban dang ranh.

Nguyen tac bao tri:

- Khong cache response live vi trang thai camera/agent thay doi lien tuc.
- Khong tra credential camera ve client.
- Moi thay doi quyen xem live nen di qua helper trong `src/lib/live`.
