# 📋 Change Log - Betabox Project

> **Quy trình làm việc:**
> - Mỗi task phải được ghi vào file này **trước khi bắt đầu code**.
> - Sau khi hoàn thành và test thành công → cập nhật trạng thái → `git commit`.
> - Nếu có lỗi nghiêm trọng → `git reset --hard HEAD` → ghi chú lỗi → xin ý kiến người dùng.

---

## Thông tin dự án

| Mục | Chi tiết |
|-----|---------|
| **Framework** | Next.js 16.2.9 |
| **Runtime** | React 19.2.4 |
| **Ngôn ngữ** | TypeScript |
| **Package Manager** | pnpm |
| **Lệnh typecheck** | `pnpm typecheck` |
| **Lệnh lint** | `pnpm lint` |
| **Lệnh build** | `pnpm build` |

---

## 📌 Quy ước Commit Message

```
feat([Module]):     Thêm tính năng mới
fix([Module]):      Sửa lỗi
refactor([Module]): Cải thiện code không thay đổi logic
chore([Module]):    Công việc phụ trợ (config, deps...)
docs([Module]):     Cập nhật tài liệu
```

---

## 📝 Lịch sử thay đổi

<!-- Thêm các task mới ở ĐÂY (phía trên các task cũ hơn) -->

### [INIT-001] - Khởi tạo hệ thống quản lý change log

- **Mục tiêu:** Tạo file `change.md` để theo dõi mọi thay đổi trong dự án theo quy trình Atomic Commit & Rollback.
- **Files tạo/sửa:** `change.md` *(mới)*
- **Chi tiết thay đổi:**
  - Tạo file `change.md` với cấu trúc đầy đủ: thông tin dự án, quy ước commit, template task.
  - Định nghĩa quy trình làm việc: ghi dự định → code → test → commit hoặc rollback.
- **Trạng thái:** ✅ Đã hoàn thành

---

## 📐 Template Task (copy để dùng lại)

```
### [MODULE-XXX] - [Tên Task]

- **Mục tiêu:** ...
- **Files tạo/sửa:**
  - `path/to/file.ts` *(mới / sửa)*
- **Chi tiết thay đổi:**
  - ...
- **Kết quả kiểm tra:**
  - `pnpm typecheck`: ...
  - `pnpm lint`: ...
- **Trạng thái:** 🔄 Đang xử lý / ✅ Đã hoàn thành / ⏪ Rollback
- **Ghi chú lỗi (nếu rollback):** ...
```
