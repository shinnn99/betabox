# src/app/api/live

Folder nay chua API route cho live station.

Endpoint chinh:

- `GET /api/live/[stationId]`: tra camera overview/QR va WHEP URL cho station.
- `GET /api/live/[stationId]/events`: poll event moi nhat de UI hien toast/alert.

Nhung diem da xu ly trong luong 2-camera:

- API phan biet viewer admin va viewer duoc gan vao station.
- Payload tra ve theo role camera de UI render dung bo cuc.

Nguyen tac bao tri:

- Khong cache response live vi trang thai camera/agent thay doi lien tuc.
- Khong tra credential camera ve client.
- Moi thay doi quyen xem live nen di qua helper trong `src/lib/live`.
