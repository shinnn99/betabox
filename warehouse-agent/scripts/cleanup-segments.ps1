# Cleanup segment cũ hơn RETENTION_DAYS trên máy kho.
#
# Chạy hàng tuần qua Task Scheduler (Chủ nhật 03:00, delay 5 phút sau
# khởi động máy). Không gọi mạng — đọc retention từ file cache local do
# agent ghi khi nhận heartbeat response.
#
# Fail-loud: nếu retention cache thiếu / hỏng → script KHÔNG chạy, ghi
# log rõ ràng. Lý do: mất dung lượng còn hơn mất bằng chứng. Silent
# default 45 = kịch bản Hạnh gõ nhầm dashboard → xóa file sớm hơn tưởng
# → mất bằng chứng không dấu vết.
#
# Guard hai lớp không xóa file đang ghi:
#   1. Bỏ qua file có LastWriteTime trong 5 phút gần nhất.
#   2. Bỏ qua toàn bộ thư mục ngày hôm nay (dạng \yyyy\mm\dd).
#
# Loại trừ thư mục _clips/ (chốt CLIPS_SUBDIR ở recording.ts).
#
# Dùng: cleanup-segments.ps1 [-WhatIf] [-AgentDir <path>]
#   -WhatIf     : chỉ IN RA danh sách sẽ xóa, không xóa thật (chạy lần đầu).
#   -AgentDir   : đường dẫn thư mục agent (chứa .env + retention-cache.json).
#                 Mặc định: "C:\Program Files\BetacomAgent".

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AgentDir = "C:\Program Files\BetacomAgent"
)

$ErrorActionPreference = "Stop"

# Log ra file cùng thư mục agent — Task Scheduler xem được, sau này agent
# push log-events sẽ pick up (đường log-từ-xa cấp 1 chưa code).
$logFile = Join-Path $AgentDir "logs\cleanup-segments.log"
$logDir = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force -WhatIf:$false | Out-Null
}

function Write-CleanupLog {
    param([string]$Level, [string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$Level] $Message"
    # -WhatIf:$false BẮT BUỘC. Không có nó thì khi chạy script với
    # -WhatIf, chính lệnh ghi log này cũng bị ShouldProcess chặn
    # ("What if: Performing the operation Add Content") → bản xem trước
    # KHÔNG để lại dấu vết nào trong file log. Đã cắn thật 12/08 trên
    # máy Đại Kim: chạy -WhatIf xong, log vẫn dừng ở lần 10/08, không
    # đối chiếu được hai lần chạy với nhau.
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -WhatIf:$false
    Write-Host $line
}

Write-CleanupLog "INFO" "=== Cleanup start (AgentDir=$AgentDir WhatIf=$($PSCmdlet.MyInvocation.BoundParameters.WhatIf.IsPresent)) ==="

# 1. Đọc retention từ cache local (không gọi mạng).
$cachePath = Join-Path $AgentDir "retention-cache.json"
if (-not (Test-Path $cachePath)) {
    Write-CleanupLog "ERROR" "retention-cache.json không tìm thấy tại $cachePath. Cleanup KHÔNG chạy. Nguyên nhân có thể: (1) Hạnh chưa cấu hình retention trên dashboard, (2) agent chưa heartbeat lần nào thành công, (3) agent chưa nâng cấp lên bản có gửi cache. Kiểm tra dashboard > Cấu hình > Thời gian lưu video."
    exit 2
}

try {
    $cacheJson = Get-Content $cachePath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-CleanupLog "ERROR" "retention-cache.json hỏng JSON: $($_.Exception.Message). Cleanup KHÔNG chạy."
    exit 2
}

$retentionDays = $cacheJson.retention_days
if ($null -eq $retentionDays -or $retentionDays -isnot [int] -or $retentionDays -lt 7 -or $retentionDays -gt 365) {
    Write-CleanupLog "ERROR" "retention_days không hợp lệ trong cache (value='$retentionDays'). Phải là số nguyên 7-365. Cleanup KHÔNG chạy."
    exit 2
}

Write-CleanupLog "INFO" "retention_days = $retentionDays ngày (cached_at=$($cacheJson.updated_at))"

# 2. Đọc RECORDING_DIR từ .env agent — không hardcode đường dẫn.
$envPath = Join-Path $AgentDir ".env"
if (-not (Test-Path $envPath)) {
    Write-CleanupLog "ERROR" ".env không tìm thấy tại $envPath. Cleanup KHÔNG chạy."
    exit 2
}

$recordingDir = $null
Get-Content $envPath -Encoding UTF8 | ForEach-Object {
    if ($_ -match "^\s*RECORDING_DIR\s*=\s*(.+)\s*$") {
        $recordingDir = $matches[1].Trim().Trim('"').Trim("'")
    }
}

if (-not $recordingDir) {
    Write-CleanupLog "ERROR" "RECORDING_DIR không tìm thấy trong $envPath. Cleanup KHÔNG chạy."
    exit 2
}

# RECORDING_DIR có thể là relative — resolve về absolute từ AgentDir.
if (-not [System.IO.Path]::IsPathRooted($recordingDir)) {
    $recordingDir = Join-Path $AgentDir $recordingDir
}

if (-not (Test-Path $recordingDir)) {
    Write-CleanupLog "ERROR" "Thư mục RECORDING_DIR không tồn tại: $recordingDir. Cleanup KHÔNG chạy."
    exit 2
}

Write-CleanupLog "INFO" "recording_dir = $recordingDir"

# 3. Tính mốc thời gian.
$now = Get-Date
$cutoff = $now.AddDays(-$retentionDays)
$recentGuard = $now.AddMinutes(-5)  # Guard 1: file mới hơn 5 phút = đang ghi.
$todayFolder = $now.ToString("yyyy\\MM\\dd")  # Guard 2: bỏ qua thư mục hôm nay.

Write-CleanupLog "INFO" "cutoff=$($cutoff.ToString('yyyy-MM-dd HH:mm:ss')) recent_guard=$($recentGuard.ToString('yyyy-MM-dd HH:mm:ss')) today_folder=$todayFolder"

# 4. Quét cameras (thư mục con trực tiếp của recording_dir), loại _clips.
$cameraDirs = Get-ChildItem -Path $recordingDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "_clips" }

# Danh sách ứng viên dùng CHUNG cho cả hai chế độ.
#
# Bug 12/08/2026: trước đây nhánh xoá thật đếm vào $totalDeleted, còn
# nhánh -WhatIf chỉ log từng dòng rồi bỏ, không đếm gì. Nên phần tổng
# kết của -WhatIf không có số để in và đành in chuỗi giữ chỗ "~files" —
# tức chế độ thử KHÔNG trả lời được câu hỏi nó sinh ra để trả lời, mà
# vẫn tạo cảm giác "đã chạy thử rồi".
#
# Hai nhánh tách rời thì kiểu gì cũng lệch lại, chỉ là lệch chỗ khác.
# Giờ CẢ HAI chế độ cùng đọc $allCandidates; khác biệt duy nhất là bước
# cuối có gọi Remove-Item hay không.
$allCandidates = New-Object System.Collections.Generic.List[object]
$totalDeleted = 0
$totalBytes = 0L
$emptyFoldersRemoved = 0

foreach ($camDir in $cameraDirs) {
    $camName = $camDir.Name

    # Cấu trúc: cameraDir/YYYY/MM/DD/*.mp4
    $candidateFiles = Get-ChildItem -Path $camDir.FullName -Recurse -File -Filter "*.mp4" -ErrorAction SilentlyContinue |
        Where-Object {
            # Guard 2: bỏ file trong thư mục ngày hôm nay.
            if ($_.FullName -like "*\$todayFolder\*") { return $false }
            # Guard 1: bỏ file mới hơn 5 phút (ffmpeg có thể đang ghi).
            if ($_.LastWriteTime -gt $recentGuard) { return $false }
            # Điều kiện chính: cũ hơn retention.
            return $_.LastWriteTime -lt $cutoff
        }

    foreach ($file in $candidateFiles) {
        $sizeBytes = $file.Length
        # Ghi vào danh sách chung TRƯỚC khi quyết định xoá — thống kê
        # phải giống hệt nhau ở hai chế độ, kể cả khi Remove-Item lỗi.
        $allCandidates.Add([pscustomobject]@{
            Camera  = $camName
            Path    = $file.FullName
            Day     = $file.LastWriteTime.ToString("yyyy-MM-dd")
            AgeDays = [int]($now - $file.LastWriteTime).TotalDays
            Bytes   = $sizeBytes
        })
        # KHÔNG log từng file ở đây: một lần xoá thật có thể có hàng nghìn
        # file, in phẳng ra là không ai đọc nổi. Tổng kết theo NGÀY ở
        # cuối script mới là thứ đọc được bằng mắt.
        if ($PSCmdlet.ShouldProcess($file.FullName, "Delete (cam=$camName age=$([int]($now - $file.LastWriteTime).TotalDays)d size=$([math]::Round($sizeBytes/1MB,1))MB)")) {
            try {
                Remove-Item -Path $file.FullName -Force
                $totalDeleted++
                $totalBytes += $sizeBytes
            } catch {
                Write-CleanupLog "WARN" "Delete failed: $($file.FullName) — $($_.Exception.Message)"
            }
        }
    }

    # 5. Dọn thư mục ngày rỗng sau khi xóa file (tránh tích tụ folder trống).
    # Chỉ dọn khi thật sự xóa (không -WhatIf), và không đụng thư mục hôm nay.
    if (-not $PSCmdlet.MyInvocation.BoundParameters.WhatIf.IsPresent) {
        Get-ChildItem -Path $camDir.FullName -Recurse -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                if ($_.FullName -like "*\$todayFolder*") { return $false }
                # Chỉ thư mục thật sự rỗng (không file, không sub-folder).
                (Get-ChildItem -Path $_.FullName -Force -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0
            } |
            Sort-Object { $_.FullName.Length } -Descending |
            ForEach-Object {
                try {
                    Remove-Item -Path $_.FullName -Force
                    $emptyFoldersRemoved++
                } catch {
                    # Ignore — có thể có file mới sinh giữa scan và delete.
                }
            }
    }
}

# 6. Tổng kết — CẢ HAI chế độ đọc cùng $allCandidates.
$isWhatIf = $PSCmdlet.MyInvocation.BoundParameters.WhatIf.IsPresent
$candidateBytes = 0L
foreach ($c in $allCandidates) { $candidateBytes += $c.Bytes }
$candidateMB = [math]::Round($candidateBytes / 1MB, 1)
$totalMB = [math]::Round($totalBytes / 1MB, 1)

# Bảng theo NGÀY: đủ để quyết định (thấy ngay có đụng vào cửa sổ ngày
# nào đang cần giữ không), mà vẫn đọc được trong mươi giây.
if ($allCandidates.Count -gt 0) {
    $sorted = $allCandidates | Sort-Object Day
    $oldest = $sorted[0].Day
    $newest = $sorted[$sorted.Count - 1].Day
    $verb = if ($isWhatIf) { "SẼ xoá" } else { "Chọn xoá" }
    Write-CleanupLog "INFO" "$verb $($allCandidates.Count) file, ${candidateMB}MB, từ $oldest tới $newest — chi tiết theo ngày:"
    foreach ($d in ($allCandidates | Group-Object Day | Sort-Object Name)) {
        $dayBytes = 0L
        foreach ($f in $d.Group) { $dayBytes += $f.Bytes }
        $cams = ($d.Group | Group-Object Camera | ForEach-Object { $_.Name }) -join ","
        Write-CleanupLog "INFO" ("    {0}  {1,5} file  {2,9} MB  [{3}]" -f $d.Name, $d.Count, [math]::Round($dayBytes / 1MB, 1), $cams)
    }
} else {
    Write-CleanupLog "INFO" "Không có file nào quá hạn (cutoff=$($cutoff.ToString('yyyy-MM-dd')))."
}

if ($isWhatIf) {
    Write-CleanupLog "INFO" "=== WHATIF summary: sẽ xoá $($allCandidates.Count) file, tổng ${candidateMB}MB. Chạy KHÔNG có -WhatIf để xóa thật ==="
} else {
    Write-CleanupLog "INFO" "=== Cleanup done: deleted=$totalDeleted/$($allCandidates.Count) files freed=${totalMB}MB empty_folders_removed=$emptyFoldersRemoved ==="
}

exit 0
