# CAPACITY_MODEL — Betabox, 10/08/2026

Đơn vị: **HTTP request tới Vercel / tháng (30 ngày)**, trừ chỗ ghi rõ khác.

Chưa nhân hệ số invocation — xem PRODUCTION_USAGE_RECONCILIATION §2, hệ số
quan sát được nằm trong khoảng **1,1–2,1** và chưa ổn định. Muốn ra
Function Invocations, nhân khoảng đó.

---

## 1. Công thức

```
REQUEST_THÁNG =
    KHO × AGENT_MỖI_KHO × 1.080.000                     (A1–A4, định kỳ)
  + KHO × CAMERA_GHI    ×    43.200                     (B1, báo segment 60s)
  + KHO × SCAN_THÁNG    ×         1                     (B2)
  + KHO × CLIP_THÁNG    ×         4                     (B5, 4 endpoint/clip)
  + TAB_DASHBOARD × GIỜ_HIỆN_THÁNG × 1.380              (W1+W2+W3)
  + NGƯỜI_XEM_CLIP × PHÚT_XEM × 30                      (W8, nhịp 2s)
```

Nguồn từng hằng số: xem REQUEST_INVENTORY §1, §2, §4.

Ngoài Vercel:
```
SUPABASE_STORAGE = CLIP_THÁNG × 1 upload  (agent → Storage trực tiếp,
                                            upload.ts:141, KHÔNG qua Vercel)
                 + lượt xem clip × 1 download
```

---

## 2. Giả định cơ sở

| Tham số | Giá trị | Nguồn |
|---|---|---|
| Agent / kho | 1 | hiện trạng, 2 agent / 2 kho |
| Camera ghi / kho | 2 | hiện trạng 3 camera active, 1 đang ghi → lấy 2 làm mức thường |
| Segment | 60s | [active-credentials.ts:77](../../src/lib/camera/active-credentials.ts#L77) |
| Scan / kho / tháng | 20.000 | **GIẢ ĐỊNH** — chưa đo, xem §6 |
| Clip / kho / tháng | 500 | **GIẢ ĐỊNH** — 19 `cut_clip`/30 ngày hiện tại là giai đoạn thử |
| Dashboard | 1 tab, 8h/ngày = 240h/tháng | **GIẢ ĐỊNH** |

Hai dòng "GIẢ ĐỊNH" là chỗ mô hình yếu nhất. Chúng **không** ảnh hưởng kết
luận chính vì phần định kỳ áp đảo, nhưng phải đo trước khi dùng để định giá.

---

## 3. Kịch bản idle (không ghi, không quét, không ai mở dashboard)

| Kho | Agent định kỳ | Tổng/tháng |
|---|---|---|
| 1 | 1.080.000 | **1.080.000** |
| 2 | 2.160.000 | **2.160.000** |
| 5 | 5.400.000 | **5.400.000** |
| 10 | 10.800.000 | **10.800.000** |

> **Hệ vượt trần Hobby (1M) ngay ở 1 kho, khi không làm gì cả.**

---

## 4. Kịch bản vận hành bình thường

2 camera ghi 24/7, 20.000 scan, 500 clip, dashboard 1 tab 8h/ngày.

| Kho | Định kỳ | Segment | Scan | Clip | Dashboard | **Tổng** |
|---|---|---|---|---|---|---|
| 1 | 1.080.000 | 86.400 | 20.000 | 2.000 | 331.200 | **1.519.600** |
| 2 | 2.160.000 | 172.800 | 40.000 | 4.000 | 662.400 | **3.039.200** |
| 5 | 5.400.000 | 432.000 | 100.000 | 10.000 | 1.656.000 | **7.598.000** |
| 10 | 10.800.000 | 864.000 | 200.000 | 20.000 | 3.312.000 | **15.196.000** |

Tỷ trọng ở mức 10 kho — **theo số HTTP request, KHÔNG phải theo chi phí**:

> ⚠️ Đây là *modeled HTTP request volume*. Tỷ trọng Function Invocations và
> compute cost **CHƯA XÁC NHẬN** — xem AUDIT_CLOSURE Gate 1. Một route ít
> request vẫn có thể đắt hơn về duration/CPU. Không trích bảng này như bảng
> chi phí.

| Nguồn | % request volume |
|---|---|
| `poll-commands` | **56,9%** |
| Dashboard | 21,8% |
| `heartbeat` + `probe` + `discovery` | 14,2% |
| Báo segment | 5,7% |
| Scan + clip | 1,4% |

---

## 5. Kịch bản dashboard 24/7 (màn hình treo tường ở kho)

Thay 240h bằng 720h/tháng → 993.600 request/tab/kho.

| Kho | Tổng/tháng | So với §4 |
|---|---|---|
| 1 | 2.182.000 | +44% |
| 2 | 4.364.000 | +44% |
| 5 | 10.910.000 | +44% |
| 10 | 21.820.000 | +44% |

Hai tab/kho thì cộng thêm đúng một lần nữa — không có cơ chế chia sẻ giữa tab
(không dùng BroadcastChannel/SharedWorker; xem REQUEST_INVENTORY §4).

---

## 6. Kịch bản lỗi

| Loại lỗi | Hệ số | Nguồn |
|---|---|---|
| Đứt mạng/DNS | **×4** trên call bị ảnh hưởng | [fetch-error.ts:137](../../warehouse-agent/src/fetch-error.ts#L137) |
| HTTP 4xx/5xx | **×1** (không retry) | [fetch-error.ts:58-68](../../warehouse-agent/src/fetch-error.ts#L58-L68) |
| Camera rớt | +1 `recording-status` mỗi lần đổi trạng thái; long-retry 5' gọi lại credentials | [commands.ts:157](../../warehouse-agent/src/commands.ts#L157) |
| Agent restart lặp | +boot-declare +recovery scan mỗi lần | [boot-declare.ts:29](../../warehouse-agent/src/boot-declare.ts#L29) |

Đứt mạng kho cả ngày, 10 kho: phần định kỳ có thể chạm **43 triệu request/tháng**
ở tình huống xấu nhất. Nhưng đứt mạng thì request không tới được Vercel, nên
đây là trần lý thuyết chứ không phải hoá đơn — trừ ca "mạng chập chờn", loại
tệ nhất vì vẫn tới nơi mà vẫn retry.

---

## 7. Kết luận capacity

| Câu hỏi | Trả lời |
|---|---|
| Hobby (1M) chịu được mấy kho? | **0.** Vượt ngay ở 1 kho lúc idle. |
| Pro (1M kèm, sau đó tính thêm) — 2 kho? | Được, ~3M request/tháng, phải trả phần vượt. |
| 5 kho? | ~7,6M request. Chi phí tuyến tính, chưa vỡ kỹ thuật. |
| 10 kho? | ~15,2M request (24/7: ~21,8M). Vẫn chưa vỡ kỹ thuật, nhưng **giá tiền tuyến tính theo số kho trong khi giá trị mang lại không tuyến tính** — đây là chỗ mô hình kinh doanh gãy, không phải chỗ hệ thống gãy. |

**Cái vỡ trước tiên không phải CPU, memory hay database — mà là hoá đơn.** Và
57% hoá đơn đó là để hỏi *"có lệnh chưa?"* 12.900 lần cho mỗi lệnh thật.

Giới hạn kỹ thuật khác chưa chạm: Fast Data Transfer 2,87/100 GB, ISR Reads
615/1M, Storage chưa đo.

---

## 8. Điều mô hình này CHƯA trả lời

- Supabase có trần riêng không (API request, Storage egress, connection)? →
  `NOT OBSERVABLE`, chưa mở trang usage Supabase.
- `/watch` (nhịp 2s) tăng theo số người xem bằng chứng — chưa có số người xem.
- Băng thông tải clip về khi khách xem — chưa đo.
- Hệ số invocation thật (1,1 hay 2,1) — chưa xác định, ảnh hưởng gấp đôi mọi
  con số ở trên.
