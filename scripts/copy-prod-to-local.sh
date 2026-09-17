#!/usr/bin/env bash
# Sao chép schema + dữ liệu từ Supabase production xuống Supabase local.
#
# Vì sao cần script này: bộ migration trong repo KHÔNG tự dựng lại được
# schema từ đầu — file migration cũ nhất là 30/06/2026, còn các bảng nền
# (organizations, cameras, packing_events, warehouse_agents...) được tạo
# trước đó ngoài repo. `supabase start` vì thế chết ở migration thứ hai.
# Cách duy nhất có local giống production là kéo nguyên schema xuống.
#
# AN TOÀN:
#   - Chỉ ĐỌC từ production (pg_dump). Không ghi gì lên project chính.
#   - Mật khẩu đọc trực tiếp từ .env.local lúc chạy, KHÔNG nhúng vào file
#     này, không ghi ra log, không đưa vào change.md.
#   - Ghi ĐÈ toàn bộ schema public của database local.
#
# LƯU Ý: dump database KHÔNG kéo theo file trong Storage. Local sẽ có đủ
# các dòng `order_proof_clips` nhưng các file .mp4 vẫn nằm trên cloud.
#
# Dùng: bash scripts/copy-prod-to-local.sh [tên_container_local]

set -euo pipefail

# Phải chạy bằng Git Bash, KHÔNG phải bash của WSL.
#
# `supabase` cài qua npm là một script shell gọi `node`. Trong WSL không
# có node của Windows nên nó chết bằng thông báo khó hiểu
# ("exec: node: not found") ở giữa chừng. Chặn sớm và nói rõ còn hơn.
if [[ -d /mnt/c || "${WSL_DISTRO_NAME:-}" != "" ]]; then
  echo "Script này phải chạy bằng Git Bash, không phải WSL." >&2
  echo "Từ cmd, chạy:  D:\\Git\\bin\\bash.exe scripts/copy-prod-to-local.sh" >&2
  exit 1
fi
for tool in supabase docker node; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Thiếu '$tool' trong PATH của shell này. Hãy dùng Git Bash." >&2
    exit 1
  }
done

CONTAINER="${1:-supabase-db}"
ENV_FILE=".env.local"
OUT_DIR=".tmp/prod-copy"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Không thấy $ENV_FILE — chạy script từ thư mục gốc của repo." >&2
  exit 1
fi

read_env() {
  grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r'
}

DB_PASSWORD="$(read_env SUPABASE_DB_PASSWORD)"
SUPABASE_URL="$(read_env NEXT_PUBLIC_SUPABASE_URL)"
PROJECT_REF="$(echo "$SUPABASE_URL" | sed 's|.*https://||; s|\.supabase\.co.*||')"

if [[ -z "$DB_PASSWORD" || -z "$PROJECT_REF" ]]; then
  echo "Thiếu SUPABASE_DB_PASSWORD hoặc NEXT_PUBLIC_SUPABASE_URL trong $ENV_FILE." >&2
  exit 1
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Không thấy container local '$CONTAINER'. Bật Supabase local trước." >&2
  exit 1
fi

# Mật khẩu phải mã hoá URL trước khi nhét vào chuỗi kết nối. Mật khẩu do
# Supabase sinh thường có ký tự đặc biệt (@ # $ % ...) — để nguyên thì
# chuỗi kết nối vỡ cú pháp và CLI báo "failed to parse connection string"
# mà không nói rõ vì sao.
DB_PASSWORD_ENC="$(DB_PASSWORD="$DB_PASSWORD" node -e 'process.stdout.write(encodeURIComponent(process.env.DB_PASSWORD))')"

# Vì sao đi qua Session Pooler chứ không nối thẳng `db.<ref>.supabase.co`:
# host trực tiếp của Supabase giờ chỉ có bản ghi IPv6 (dải 2406:da18::/32
# = AWS ap-southeast-1). Máy chạy script này không có IPv6 ra Internet nên
# pg_dump nhận "Connection refused". Pooler có IPv4.
#
# Cổng 5432 = session mode, bắt buộc cho pg_dump. KHÔNG dùng 6543
# (transaction mode) — nó không giữ session, pg_dump sẽ hỏng giữa chừng.
#
# Đặt POOLER_HOST=... để ép region khác nếu project được chuyển vùng.
POOLER_CANDIDATES=(
  "${POOLER_HOST:-}"
  "aws-0-ap-southeast-1.pooler.supabase.com"
  "aws-1-ap-southeast-1.pooler.supabase.com"
)

mkdir -p "$OUT_DIR"

DB_URL=""
for host in "${POOLER_CANDIDATES[@]}"; do
  [[ -z "$host" ]] && continue
  candidate="postgresql://postgres.${PROJECT_REF}:${DB_PASSWORD_ENC}@${host}:5432/postgres"
  echo "==> [0/4] Thử kết nối qua $host"
  if supabase db dump --db-url "$candidate" -f "$OUT_DIR/.probe.sql" >/dev/null 2>&1; then
    DB_URL="$candidate"
    rm -f "$OUT_DIR/.probe.sql"
    echo "    kết nối được."
    break
  fi
done

if [[ -z "$DB_URL" ]]; then
  echo "Không kết nối được tới project qua bất kỳ pooler nào đã thử." >&2
  echo "Lấy chuỗi kết nối Session Pooler trong Supabase Dashboard > Project Settings > Database," >&2
  echo "rồi chạy lại với:  POOLER_HOST=<host> bash scripts/copy-prod-to-local.sh" >&2
  exit 1
fi

echo "==> [1/4] Kéo schema từ project ${PROJECT_REF} (chỉ đọc)"
supabase db dump --db-url "$DB_URL" -f "$OUT_DIR/schema.sql"

echo "==> [2/4] Kéo dữ liệu (chỉ đọc)"
supabase db dump --db-url "$DB_URL" --data-only -f "$OUT_DIR/data.sql"

echo "==> [3/4] Nạp schema vào local ($CONTAINER)"
docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=0 < "$OUT_DIR/schema.sql" >/dev/null

echo "==> [4/4] Nạp dữ liệu vào local ($CONTAINER)"
docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=0 < "$OUT_DIR/data.sql" >/dev/null

echo
echo "==> Đối chiếu số dòng local"
docker exec "$CONTAINER" psql -U postgres -d postgres -c "
  select relname as bang, n_live_tup as so_dong
  from pg_stat_user_tables
  where schemaname = 'public'
  order by n_live_tup desc
  limit 20;"

echo
echo "Xong. File dump nằm ở $OUT_DIR — CÓ chứa dữ liệu thật, đừng commit."
