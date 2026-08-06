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
    [string]$AgentDir = "C:\Program Files\BetacomAgent",
    # Cache ôi: agent ghi lại retention-cache.json ở MỖI heartbeat thành công
    # (index.ts), nên mtime cũ = agent mất liên lạc với cloud ngần ấy lâu.
    # Quá ngưỡng này thì giá trị retention không còn đáng tin (VD ai đó vừa
    # hạ retention của org mà agent chưa nhận được) → fail-loud.
    # 7 ngày: bỏ qua mất mạng ngắn, bắt được ca "heartbeat chết mấy tuần".
    # Không dọn thì đĩa đầy dần — nhưng disk guard trong agent là lưới đỡ
    # cho đúng ca đó, còn xoá theo số sai thì không có lưới nào.
    [int]$MaxCacheAgeDays = 7
)

$ErrorActionPreference = "Stop"

# Log ra file cùng thư mục agent — Task Scheduler xem được, agent đọc lại
# rồi phát lên cloud qua console.warn (cleanup-log-relay.ts).
#
# DÙNG .NET TRỰC TIẾP, KHÔNG dùng New-Item/Add-Content: script khai
# SupportsShouldProcess nên `-WhatIf` lan xuống MỌI cmdlet bên trong, kể cả
# hai cmdlet ghi log — đã verify 2026-08-06: chạy `-WhatIf` không tạo thư
# mục logs, không ghi dòng nào, một lượt chạy thử không để lại dấu vết gì.
# Lời gọi .NET không chịu ShouldProcess nên chạy thử vẫn có sổ.
# `Remove-Item` KHÔNG bị ảnh hưởng: nó còn lớp $PSCmdlet.ShouldProcess tự
# viết bên dưới, hàng rào không hạ.
$logFile = Join-Path $AgentDir "logs\cleanup-segments.log"
$logDir = Split-Path $logFile -Parent
[System.IO.Directory]::CreateDirectory($logDir) | Out-Null

$logEncoding = New-Object System.Text.UTF8Encoding($false)  # không BOM

function Write-CleanupLog {
    param([string]$Level, [string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$Level] $Message"
    try {
        [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $logEncoding)
    } catch {
        Write-Host "[$ts] [WARN] Không ghi được log file: $($_.Exception.Message)"
    }
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

$cacheAgeDays = ((Get-Date) - (Get-Item $cachePath).LastWriteTime).TotalDays
if ($cacheAgeDays -gt $MaxCacheAgeDays) {
    Write-CleanupLog "ERROR" "retention-cache.json ÔI: mtime cũ $([math]::Round($cacheAgeDays,1)) ngày (ngưỡng $MaxCacheAgeDays). Agent ghi lại cache mỗi heartbeat thành công, nên cache cũ = agent mất liên lạc cloud ngần ấy lâu; giá trị retention=$retentionDays có thể đã lỗi thời. Cleanup KHÔNG chạy. Kiểm agent còn sống và có heartbeat được không."
    exit 2
}

Write-CleanupLog "INFO" "retention_days = $retentionDays ngày (cached_at=$($cacheJson.updated_at), cache_age=$([math]::Round($cacheAgeDays,1))d)"

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

# Chuẩn hoá: Join-Path với "./recordings" để lại vết `\.\` giữa đường dẫn.
# Windows giải đúng nên vô hại khi chạy, nhưng nó nằm nguyên văn trong log
# và ba tháng sau đọc lại trông như lỗi.
$recordingDir = (Resolve-Path -LiteralPath $recordingDir).Path

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

$totalDeleted = 0
$totalBytes = 0L
$emptyFoldersRemoved = 0

foreach ($camDir in $cameraDirs) {
    $camName = $camDir.Name

    # Chỉ quét thư mục khớp KHUÔN NGÀY `YYYY/MM/DD`. Trước đây script quét
    # đệ quy mọi thứ không tên `_clips` — tức `_clips` là default-deny còn
    # phần còn lại default-allow. Verify 2026-08-06 trên cây giả: thư mục
    # `logs/` bị coi như camera và MẤT 2 file .mp4 trong đó. Rủi ro thật,
    # không phải lý thuyết.
    #
    # Nhận diện bằng hình dạng thư mục chứ không bằng danh sách camera từ
    # cache: luật an toàn không được phụ thuộc vào một đường dữ liệu có thể
    # hỏng (cache ôi/thiếu/heartbeat chết). Khuôn ngày nằm hoàn toàn trong
    # dữ liệu script đang đứng nhìn, đúng nguyên lý cắt tỉa theo tên thư mục
    # mà disk-guard.ts đang dùng — một quy ước, hai chỗ đọc.
    $dayDirs = @()
    $skippedDirs = @()
    foreach ($y in @(Get-ChildItem -Path $camDir.FullName -Directory -ErrorAction SilentlyContinue)) {
        if ($y.Name -notmatch '^\d{4}$') { $skippedDirs += $y.Name; continue }
        foreach ($m in @(Get-ChildItem -Path $y.FullName -Directory -ErrorAction SilentlyContinue)) {
            if ($m.Name -notmatch '^\d{2}$') { $skippedDirs += "$($y.Name)\$($m.Name)"; continue }
            foreach ($d in @(Get-ChildItem -Path $m.FullName -Directory -ErrorAction SilentlyContinue)) {
                if ($d.Name -notmatch '^\d{2}$') { $skippedDirs += "$($y.Name)\$($m.Name)\$($d.Name)"; continue }
                $dayDirs += $d
            }
        }
    }
    if ($skippedDirs.Count -gt 0) {
        Write-CleanupLog "INFO" "cam=$camName bỏ qua $($skippedDirs.Count) thư mục không khớp khuôn ngày: $($skippedDirs -join ', ')"
    }
    if ($dayDirs.Count -eq 0) {
        # Thư mục cấp một không có thư mục ngày nào → gần như chắc chắn không
        # phải camera (VD `logs/` với file phẳng bên trong). Không xoá gì, và
        # ghi lại để Hạnh thấy có thứ lạ nằm trong RECORDING_DIR.
        Write-CleanupLog "INFO" "cam=$camName không có thư mục khuôn ngày nào — bỏ qua toàn bộ (có thể không phải thư mục camera)"
        continue
    }

    # File CHỈ lấy trực tiếp trong thư mục ngày — không đệ quy sâu hơn.
    $candidateFiles = @($dayDirs | ForEach-Object {
            Get-ChildItem -Path $_.FullName -File -Filter "*.mp4" -ErrorAction SilentlyContinue
        }) |
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
        if ($PSCmdlet.ShouldProcess($file.FullName, "Delete (cam=$camName age=$([int]($now - $file.LastWriteTime).TotalDays)d size=$([math]::Round($sizeBytes/1MB,1))MB)")) {
            try {
                Remove-Item -Path $file.FullName -Force
                $totalDeleted++
                $totalBytes += $sizeBytes
            } catch {
                Write-CleanupLog "WARN" "Delete failed: $($file.FullName) — $($_.Exception.Message)"
            }
        } else {
            # -WhatIf mode: chỉ ghi log, không đếm vào totalBytes (chưa xóa).
            Write-CleanupLog "WHATIF" "Would delete: $($file.FullName) age=$([int]($now - $file.LastWriteTime).TotalDays)d size=$([math]::Round($sizeBytes/1MB,1))MB"
        }
    }

    # 5. Dọn thư mục rỗng sau khi xóa file (tránh tích tụ folder trống).
    # Chỉ dọn khi thật sự xóa (không -WhatIf), và không đụng thư mục hôm nay.
    #
    # CHỈ đụng thư mục khớp khuôn ngày — cùng luật với vòng quét ở trên, để
    # một thư mục lạ rỗng (VD `logs/` sau khi ai đó dọn tay) không bị xoá.
    #
    # Thứ tự ngày → tháng → năm trong CÙNG một lượt: mỗi tầng kiểm lại độ
    # rỗng tại thời điểm kiểm, nên tầng trên thấy được kết quả xoá của tầng
    # dưới. Bản cũ dùng một pipeline `Where-Object` chạy TRƯỚC `Sort-Object`
    # nên độ rỗng được chốt trước khi xoá gì → mỗi lượt chỉ leo được một
    # tầng, thư mục tháng phải chờ tuần sau, thư mục năm chờ tuần sau nữa
    # (verify 2026-08-06: lượt 1 dọn tầng ngày, lượt 3 tầng tháng, lượt 4
    # tầng năm).
    #
    # THƯ MỤC CAMERA KHÔNG BAO GIỜ BỊ DỌN, kể cả khi rỗng: nó là dấu vết duy
    # nhất còn lại rằng camera đó từng tồn tại. Khi tra một đơn cũ, phân biệt
    # "camera từng có, dữ liệu đã hết hạn" với "chưa từng có camera nào ở
    # đây" là khác biệt thật.
    if (-not $PSCmdlet.MyInvocation.BoundParameters.WhatIf.IsPresent) {
        $removeIfEmpty = {
            param($dir)
            if ($dir.FullName -like "*\$todayFolder*") { return }
            if ((Get-ChildItem -Path $dir.FullName -Force -ErrorAction SilentlyContinue | Measure-Object).Count -ne 0) { return }
            try {
                Remove-Item -Path $dir.FullName -Force
                $script:emptyFoldersRemoved++
            } catch {
                # Ignore — có thể có file mới sinh giữa scan và delete.
            }
        }
        foreach ($d in $dayDirs) { & $removeIfEmpty $d }
        foreach ($y in @(Get-ChildItem -Path $camDir.FullName -Directory -ErrorAction SilentlyContinue)) {
            if ($y.Name -notmatch '^\d{4}$') { continue }
            foreach ($m in @(Get-ChildItem -Path $y.FullName -Directory -ErrorAction SilentlyContinue)) {
                if ($m.Name -match '^\d{2}$') { & $removeIfEmpty $m }
            }
            & $removeIfEmpty $y
        }
    }
}

# 6. Tổng kết.
$totalMB = [math]::Round($totalBytes / 1MB, 1)
if ($PSCmdlet.MyInvocation.BoundParameters.WhatIf.IsPresent) {
    Write-CleanupLog "INFO" "=== WHATIF summary: would delete ~files matching filter; run WITHOUT -WhatIf để xóa thật ==="
} else {
    Write-CleanupLog "INFO" "=== Cleanup done: deleted=$totalDeleted files freed=${totalMB}MB empty_folders_removed=$emptyFoldersRemoved ==="
}

exit 0
