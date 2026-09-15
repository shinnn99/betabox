# src/app/api/cameras/[id]/recording

Folder nay chua API dieu khien recording cua mot camera cu the.

Endpoint chinh:

- `POST /api/cameras/[id]/recording/start`
- `POST /api/cameras/[id]/recording/stop`
- `GET /api/cameras/[id]/recording/status`

Nhung diem da xu ly trong luong 2-camera:

- Start/stop recording can nham dung agent quan ly camera do.
- Session va segment file phai co `agent_id` de lenh cat clip di ve dung may dang giu file.

Nguyen tac bao tri:

- Khong stop recording theo organization-wide agent mac dinh.
- Neu camera doi station/agent, phai dong bo camera row, command target va recording session.
- API nay dieu khien recording, khong dieu khien viewer live toggle tren UI.
