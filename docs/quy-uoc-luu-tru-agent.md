# Quy ước lưu trữ trên máy kho

Hai quy ước dưới đây có **nhiều nơi đọc**, và đều là loại tri thức mà người
sau dễ phá vì tưởng mình đang dọn dẹp. Sửa một nơi mà không sửa các nơi kia
thì hỏng im lặng — không có test nào bắt được vì mỗi nơi vẫn tự nhất quán.

Ghi lại 2026-08-06, sau đợt verify `cleanup-segments.ps1` + disk guard.

---

## 1. Thư mục camera nhận diện bằng KHUÔN NGÀY `YYYY/MM/DD`

Layout: `<RECORDING_DIR>/<camera_code>/<YYYY>/<MM>/<DD>/<code>_<YYYYMMDD>_<HHMMSS>.mp4`

Bất cứ thứ gì quét cây segment **chỉ được đi vào thư mục khớp khuôn ngày** —
bốn chữ số, hai chữ số, hai chữ số — và chỉ lấy file **trực tiếp trong thư
mục ngày**, không đệ quy sâu hơn.

### Vì sao không dùng danh sách camera

Danh sách camera phải lấy từ đâu đó: cache local, DB, heartbeat. Mỗi nguồn
đều có thể hỏng (cache ôi, cache thiếu, agent mất mạng), và lúc đó luật an
toàn phải chọn giữa "không quét gì" (đĩa đầy dần) hay "quét tất cả" (đúng lại
lỗ cũ, ở đúng lúc hệ thống đang có vấn đề).

Khuôn ngày nằm hoàn toàn trong dữ liệu mà đoạn code đang đứng nhìn, nên nó
đúng **kể cả khi mọi thứ khác hỏng**.

### Vì sao quan trọng

Trước 2026-08-06, `cleanup-segments.ps1` quét đệ quy mọi thư mục không tên
`_clips` — tức `_clips` là default-deny còn phần còn lại default-allow. Verify
trên cây giả: thư mục `logs/` bị coi như một camera và **mất 2 file `.mp4`**.
Đây là lỗi đã xảy ra thật trong bài kiểm, không phải rủi ro lý thuyết.

### Nơi đọc quy ước này

| Nơi | Vai trò |
|---|---|
| `warehouse-agent/scripts/cleanup-segments.ps1` | chọn file để xoá theo retention |
| `warehouse-agent/src/disk-guard.ts` → `listSegmentCandidates` | chọn ứng viên khi đĩa sắp đầy; cắt tỉa theo tên thư mục để không stat ngày còn trong sàn |
| `warehouse-agent/src/disk-guard.ts` → `inferCamerasFromDisk` | suy camera + thư mục mẫu khi không tiến trình nào đang ghi |

### Đệm múi giờ

Thư mục ngày do agent tạo theo giờ **địa phương**, còn khi quy ra mốc thời
gian thì đọc là UTC. Ở VN (UTC+7) thư mục `2026-08-06` thật ra bắt đầu lúc
`2026-08-05T17:00Z`. `disk-guard.ts` cộng `TZ_SLACK_MS = 14h` khi so với sàn —
luôn lệch về phía **giữ file lâu hơn**, không bao giờ ngắn hơn.

---

## 2. `fs.statfs` bám theo junction sang volume ĐÍCH

Trực giác tự nhiên là "link nằm ở đâu thì đo ở đó". Sai.

Đo trên máy dev 2026-08-06:

| Đường dẫn | free | total |
|---|---|---|
| `Get-PSDrive C:` | 22,3 GB | 250 GB |
| `Get-PSDrive D:` | 83,8 GB | 127,7 GB |
| `readVolumeUsage(D:\...\warehouse-agent)` | 83,8 | 127,7 |
| `readVolumeUsage(junction trên D: → C:)` | **22,3** | **250,0** |

Junction nằm trên D: nhưng trỏ vào C: cho ra đúng số của C:.

**Đây là hành vi mình cần**: nó đo đúng nơi byte thật sự rơi xuống. Nếu kho
nào để `RECORDING_DIR` trỏ sang ổ ngoài bằng junction, disk guard vẫn đo đúng
ổ đó chứ không đo ổ hệ điều hành.

`fs.statfs` cũng nhận đường dẫn **thư mục con**, không cần đưa gốc volume.

---

## 3. Chạy thử — cả hai lớp đều quan sát được mà không mất byte nào

| Lớp | Lệnh | Ghi log? |
|---|---|---|
| Script dọn theo retention | `cleanup-segments.ps1 -WhatIf` | Có (từ 2026-08-06 — trước đó `-WhatIf` nuốt luôn log) |
| Disk guard | `betacom-agent.exe --disk-guard-dry-run` | Có, kèm 1 dòng lên cloud |

`--disk-guard-dry-run` chạy được **trong lúc service đang ghi**: tiến trình
CLI không thấy camera nào đang recording nên guard tự suy tốc độ ăn đĩa từ
segment trên ổ (giả định `segmentSeconds=60`; segment thật dài hơn thì tốc độ
ước lượng cao hơn thực tế → guard bi quan, lệch về phía an toàn).

Dùng lúc onboarding kho mới để trả lời "ngưỡng đặt đúng chưa" ngay ngày lắp
máy. Ba số cần đọc: dung lượng quy ra **giờ ghi** (GB trống không nói được
ngưỡng đúng/sai), **dải ngày** sẽ bị đụng, và **có chạm sàn không** — chạm sàn
ngay lần đầu nghĩa là ổ quá nhỏ so với retention, phải xử lý bằng phần cứng
chứ không bằng cách chỉnh ngưỡng.

`dryRun` là một **phương thức riêng**, không phải cờ khởi động: cờ có thể bị
bật ở kho khách rồi quên, và guard sẽ nằm im vĩnh viễn trong khi nhìn vẫn như
đang chạy.

---

## 4. Hai lớp lỗi đã gặp, sẽ tái xuất ở chỗ khác

### 4.1. "Chưa đo được" không được mặc định thành "không sao"

Ngưỡng của disk guard tính từ **tốc độ ăn đĩa đo được**. Trước 2026-08-06,
khi không tiến trình nào đang ghi thì tốc độ = `null`, và cả tầng cảnh báo lẫn
tầng hành động **tự tắt** — chỉ còn sàn tuyệt đối, mà sàn thì thiết kế để chặn
guard chạy loạn, không phải để bảo vệ đĩa.

Kịch bản thật: kho nghỉ Tết, camera hỏng cuối tuần, agent vừa khởi động lại.
Guard chuyển từ chủ động sang gần như trơ, đúng lúc không ai để ý. Không lỗi,
không cảnh báo — chỉ là một tầng bảo vệ tự tắt.

Đã vá (suy tốc độ từ segment trên ổ). Nhưng lớp lỗi thì tổng quát: **bất kỳ
ngưỡng nào tính từ một đại lượng đo được đều có trạng thái "chưa đo được", và
mặc định của trạng thái đó phải được chọn có ý thức** chứ không để rơi vào
`null` rồi tắt lặng lẽ.

### 4.2. Bản ghi THI HÀNH không phải bản ghi KẾT QUẢ

Đã gặp hai lần, ở hai hệ thống khác nhau — nên không phải bài học riêng của
một dự án:

- BetacomEdu: migration được ghi nhận là đã chạy nhưng không có tác dụng.
- Ở đây: `Remove-Item`/`fs.unlink` có thể thất bại (file còn handle — trên
  Windows là `EBUSY`, hành vi **lặp lại được** chứ không hi hữu) mà vẫn bị
  đếm là "đã xoá".

Cách xử lý đã áp dụng ở cả hai lớp:

- `cleanup-segments.ps1` chỉ tăng `$totalDeleted` **sau khi** `Remove-Item`
  thành công (verify: chọn 11, báo 9, thực sự mất 9).
- `disk-guard.ts` đo lại `statfs` sau **mỗi lô** và có báo động riêng cho ca
  "xoá được file mà không đòi được chỗ" — khác hẳn "đĩa sắp đầy", nguyên nhân
  và cách xử lý đều khác.

Hệ quả cho báo động sau này: vì `EBUSY` là bình thường ở kho đang ghi, ngưỡng
báo động về file bị khoá phải theo **tỷ lệ** chứ không theo sự hiện diện. Vài
file khoá ở rìa mới nhất là đúng thiết kế; phần lớn lô bị khoá mới là dấu hiệu
có thứ khác đang giữ file (Defender, tiến trình sao lưu).

### 4.3. Cây giả kiểm LUẬT, cây thật kiểm GIẢ ĐỊNH

Ba lỗi im lặng trong cùng một đợt (2026-08-06) đều **chỉ lộ ra khi chạy trên
dữ liệu thật có rác thật**, không cái nào bị cây giả bắt:

| Lỗi | Cây giả nói gì | Cây thật nói gì |
|---|---|---|
| `cleanup-segments.ps1` quét thư mục lạ | (phải cố ý dựng `logs/` mới thấy) | `logs/` mất 2 file `.mp4` |
| `measureRate` trả `null` khi không cam nào ghi | không có khái niệm "đang ghi" | cả 2 tầng ngưỡng tự tắt |
| Thư mục ngày mới nhất RỖNG | cây dựng ra luôn có file | `cam_02`, `CAM_HONG_TEST` đều rỗng |

Lý do: cây giả được dựng từ **hiểu biết hiện tại** về cấu trúc, nên nó chỉ
kiểm được LUẬT mình đã nghĩ ra. Còn cây thật mang theo lịch sử — thư mục còn
lại sau khi dọn, camera đã gỡ, file lỡ tay, cấu hình cũ — nên nó kiểm được
GIẢ ĐỊNH mình không biết là mình đang đặt.

Quy tắc: mọi thứ quét cây segment phải chạy **ít nhất một lần trên cây thật**
trước khi giao khách, và chạy ở chế độ quan sát (`-WhatIf` / `--disk-guard-dry-run`)
để không phải trả giá cho lần đầu.

### 4.4. Giả định về thời gian trong môi trường thật luôn thô hơn trong đầu

- Granularity timer Windows ~15,6ms: test nào dựa vào `setTimeout` dưới ~20ms
  đều không đáng tin (đã làm nhấp nháy test coalesce của `SerializedWriter`).
- `LastWriteTime` của segment lệch `started_at` khoảng 60 giây (thời điểm ghi
  **xong** so với ghi **bắt đầu**) — nên con số `-WhatIf` không bao giờ khớp
  tuyệt đối với một truy vấn DB theo `started_at`.
