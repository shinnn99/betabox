# src/app/api/agent

Folder nay chua cac endpoint rieng cho Warehouse Agent.

Vai tro chinh:

- Agent boot/heartbeat/poll command.
- Agent bao ket qua lenh, status recording, segment file, clip cut/upload result.
- Agent lay credential recording tam thoi de mo RTSP stream.

Nhung diem da xu ly trong luong 2-camera:

- Lenh camera/recording/clip phai huong den `agent_id` cua camera hoac segment, khong mac dinh theo to chuc.
- Credential camera chi duoc agent lay khi can mo stream va khong duoc ghi ra disk/log.
- Cac endpoint clip upload ket noi workflow proof 2-camera voi file segment local.

Nguyen tac bao tri:

- Moi route agent phai xac thuc chu ky/secret theo helper warehouse auth hien co.
- Khong tra du lieu cua agent nay cho agent khac.
- Log error co RTSP URL phai redacted truoc khi ghi.
