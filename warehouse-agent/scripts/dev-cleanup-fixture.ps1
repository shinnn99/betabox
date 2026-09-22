# Dựng cây giả để kiểm `cleanup-segments.ps1` — CHỈ DÙNG TRÊN MÁY DEV.
#
# Vì sao cần: cleanup-segments.ps1 chưa từng thi hành `Remove-Item` ở bất kỳ
# đâu (Task Scheduler máy dev không có task, Đại Kim chưa có file nào quá
# hạn — lần đầu rơi vào 2026-08-23, trên kho khách). Kiểm bằng tay thì không
# lặp lại được; mỗi biến thể cần một cây sạch.
#
# Cây dựng ra mô phỏng đúng layout thật:
#   <Root>/.env                     RECORDING_DIR=./recordings
#   <Root>/retention-cache.json     (tuỳ -Cache)
#   <Root>/recordings/<cam>/YYYY/MM/DD/*.mp4
#   <Root>/recordings/_clips/*.mp4                     ← không được đụng
#   <Root>/recordings/_clips/_quarantine/...           ← không được đụng
#   <Root>/recordings/logs/*.mp4                       ← thư mục LẠ (không phải camera)
#
# Biến thể cache (-Cache): valid | missing | corrupt | zero | negative | huge | stale
#   huge  = 36500 — một chữ số thừa khi sửa retention trên dashboard.
#   stale = hợp lệ nhưng mtime cũ (agent chết lâu, cache ôi).
#
# Dùng:
#   .\dev-cleanup-fixture.ps1 -Root C:\temp\fx -Cache valid
#   .\dev-cleanup-fixture.ps1 -Root C:\temp\fx -Cache huge -NoStray

param(
    [Parameter(Mandatory = $true)][string]$Root,
    [int]$RetentionDays = 35,
    [ValidateSet("valid", "missing", "corrupt", "zero", "negative", "huge", "stale")]
    [string]$Cache = "valid",
    [int]$CacheAgeDays = 30,
    [switch]$NoStray,
    [switch]$NoQuarantine
)

$ErrorActionPreference = "Stop"

if (Test-Path $Root) { Remove-Item -Path $Root -Recurse -Force }
New-Item -ItemType Directory -Path $Root -Force | Out-Null

$rec = Join-Path $Root "recordings"
$now = Get-Date

function New-Seg {
    param([string]$CamDir, [datetime]$At, [string]$Name, [int]$SizeKB = 64)
    $dir = Join-Path $CamDir ($At.ToString("yyyy\\MM\\dd"))
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $p = Join-Path $dir $Name
    $fs = [System.IO.File]::Create($p)
    $fs.SetLength($SizeKB * 1KB)
    $fs.Close()
    (Get-Item $p).LastWriteTime = $At
    return $p
}

# --- Camera A: 2 ngày quá hạn + 1 ngày trong hạn + thư mục hôm nay ---
$camA = Join-Path $rec "cam_a"
$old1 = $now.AddDays(-50)
$old2 = $now.AddDays(-40)
$fresh = $now.AddDays(-2)

$lockMiddle = $null
1..5 | ForEach-Object { New-Seg $camA $old1 ("cam_a_" + $old1.ToString("yyyyMMdd") + "_00000$_.mp4") | Out-Null }
1..5 | ForEach-Object {
    $p = New-Seg $camA $old2 ("cam_a_" + $old2.ToString("yyyyMMdd") + "_00000$_.mp4")
    if ($_ -eq 3) { $script:lockMiddle = $p }   # file GIỮA thư mục nhiều file → khoá
}
1..3 | ForEach-Object { New-Seg $camA $fresh ("cam_a_" + $fresh.ToString("yyyyMMdd") + "_00000$_.mp4") | Out-Null }
1..3 | ForEach-Object { New-Seg $camA $now ("cam_a_" + $now.ToString("yyyyMMdd") + "_00000$_.mp4") | Out-Null }

# --- Camera B: đúng MỘT file quá hạn, sẽ bị khoá → kiểm bước dọn thư mục rỗng
#     khi xoá thất bại (thư mục vẫn còn file, không được coi là rỗng).
$camB = Join-Path $rec "cam_b"
$lockAlone = New-Seg $camB $now.AddDays(-45) ("cam_b_" + $now.AddDays(-45).ToString("yyyyMMdd") + "_000001.mp4")

# --- _clips: chứng dương cho luật loại trừ (đủ cũ để LẼ RA bị chọn) ---
$clips = Join-Path $rec "_clips"
New-Item -ItemType Directory -Path $clips -Force | Out-Null
1..3 | ForEach-Object {
    $p = Join-Path $clips "abcdefab-cdef-4def-8def-00000000000$_.mp4"
    [System.IO.File]::WriteAllBytes($p, (New-Object byte[] (32KB)))
    (Get-Item $p).LastWriteTime = $old1
}

if (-not $NoQuarantine) {
    $q = Join-Path $clips "_quarantine\stale-recovery\20260701T000000_clip_test_reason"
    New-Item -ItemType Directory -Path $q -Force | Out-Null
    1..2 | ForEach-Object {
        $p = Join-Path $q "quarantined_$_.mp4"
        [System.IO.File]::WriteAllBytes($p, (New-Object byte[] (16KB)))
        (Get-Item $p).LastWriteTime = $old1
    }
}

# --- Thư mục LẠ: không phải camera. Script lọc `Name -ne "_clips"` nên nó
#     lọt vào vòng quét như một camera (default-allow). Có 1 file không phải
#     .mp4 để xem `-Filter *.mp4` có chừa ra không.
if (-not $NoStray) {
    $stray = Join-Path $rec "logs"
    New-Item -ItemType Directory -Path $stray -Force | Out-Null
    1..2 | ForEach-Object {
        $p = Join-Path $stray "app-$_.mp4"
        [System.IO.File]::WriteAllBytes($p, (New-Object byte[] (8KB)))
        (Get-Item $p).LastWriteTime = $old1
    }
    $t = Join-Path $stray "app.txt"
    [System.IO.File]::WriteAllBytes($t, (New-Object byte[] (1KB)))
    (Get-Item $t).LastWriteTime = $old1
}

# --- .env ---
Set-Content -Path (Join-Path $Root ".env") -Encoding UTF8 -Value @(
    "AGENT_CODE=fixture",
    "RECORDING_DIR=./recordings"
)

# --- retention-cache.json theo biến thể ---
$cachePath = Join-Path $Root "retention-cache.json"
switch ($Cache) {
    "missing" { }
    "corrupt" { Set-Content -Path $cachePath -Encoding UTF8 -Value "{ retention_days: 35,,, " }
    "zero" { Set-Content -Path $cachePath -Encoding UTF8 -Value '{ "retention_days": 0, "updated_at": "2026-08-06T00:00:00.000Z" }' }
    "negative" { Set-Content -Path $cachePath -Encoding UTF8 -Value '{ "retention_days": -5, "updated_at": "2026-08-06T00:00:00.000Z" }' }
    "huge" { Set-Content -Path $cachePath -Encoding UTF8 -Value '{ "retention_days": 36500, "updated_at": "2026-08-06T00:00:00.000Z" }' }
    default {
        Set-Content -Path $cachePath -Encoding UTF8 -Value ('{ "retention_days": ' + $RetentionDays + ', "updated_at": "' + $now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + '" }')
        if ($Cache -eq "stale") { (Get-Item $cachePath).LastWriteTime = $now.AddDays(-$CacheAgeDays) }
    }
}

# --- Manifest ---
$allMp4 = Get-ChildItem -Path $rec -Recurse -File -Filter *.mp4
$manifest = [ordered]@{
    root            = $Root
    cache_variant   = $Cache
    retention_days  = $RetentionDays
    total_mp4       = $allMp4.Count
    lock_alone      = $lockAlone
    lock_middle     = $script:lockMiddle
    protected_clips = (Get-ChildItem -Path $clips -Recurse -File -Filter *.mp4).Count
}
$manifest | ConvertTo-Json | Set-Content -Path (Join-Path $Root "fixture-manifest.json") -Encoding UTF8
$manifest.GetEnumerator() | ForEach-Object { "{0,-16}= {1}" -f $_.Key, $_.Value }
