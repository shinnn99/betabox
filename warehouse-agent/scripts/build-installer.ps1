# ============================================================
# Betacom Warehouse Agent — build installer 1 file .exe
# ============================================================
# Chạy: cd warehouse-agent; .\scripts\build-installer.ps1
#
# Trình tự:
#   1. npm run build         → dist/index.js
#   2. pkg dist/index.js     → dist-exe/betacom-agent.exe
#   3. verify ffmpeg/ffprobe/nssm có sẵn
#   4. iscc installer/betacom-agent.iss → dist-installer/BetacomAgentSetup-vX.Y.exe
#
# Yêu cầu:
#   - Node.js 22+ (đã có, dev-dep @yao-pkg/pkg)
#   - Inno Setup 6 (Hạnh cài từ jrsoftware.org/isdl.php)
#   - ffmpeg.exe/ffprobe.exe có sẵn ở dist-package/BetacomAgent/
#     (đã build từ trước — nếu mất, tải lại từ gyan.dev/ffmpeg)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "==> [1/4] Build Node TS..." -ForegroundColor Cyan
npm run build

Write-Host "==> [2/4] Build betacom-agent.exe (pkg)..." -ForegroundColor Cyan
npm run build:exe

Write-Host "==> [3/4] Verify prerequisites..." -ForegroundColor Cyan
$requiredFiles = @(
    "dist-exe\betacom-agent.exe",
    "dist-package\BetacomAgent\ffmpeg.exe",
    "dist-package\BetacomAgent\ffprobe.exe",
    "vendor\nssm\nssm.exe",
    "installer\betacom-agent.iss",
    "scripts\cleanup-segments.ps1"
)
foreach ($f in $requiredFiles) {
    if (!(Test-Path $f)) {
        Write-Host "  THIẾU: $f" -ForegroundColor Red
        exit 1
    }
    $size = (Get-Item $f).Length
    Write-Host ("  OK   {0,-55} {1,10:N0} bytes" -f $f, $size) -ForegroundColor Green
}

# Guard BOM: file .ps1 có ký tự Unicode (tiếng Việt) PHẢI có UTF-8 BOM
# (EF BB BF). PS 5.1 (Windows built-in) đọc file không BOM bằng ANSI →
# tiếng Việt vỡ → parser lỗi trên máy khách. Bug 2026-07-22 (v0.8.1 giao
# khách sẽ dính đúng ca này). Chặn build.
$ps1Files = @("scripts\cleanup-segments.ps1")
foreach ($ps1 in $ps1Files) {
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $ps1))
    if ($bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
        Write-Host "  THIẾU BOM: $ps1 (byte đầu $($bytes[0]) $($bytes[1]) $($bytes[2])). Ghi lại với UTF-8 BOM trước build." -ForegroundColor Red
        exit 1
    }
    Write-Host ("  BOM  {0,-55} UTF-8 BOM OK" -f $ps1) -ForegroundColor Green
}

Write-Host "==> [4/4] Chạy Inno Setup compiler..." -ForegroundColor Cyan
$isccCandidates = @(
    "C:\Program Files (x86)\Inno Setup 6\iscc.exe",
    "C:\Program Files\Inno Setup 6\iscc.exe"
)
$iscc = $null
foreach ($c in $isccCandidates) {
    if (Test-Path $c) { $iscc = $c; break }
}
if (-not $iscc) {
    Write-Host "Không tìm thấy iscc.exe. Cài Inno Setup 6 từ https://jrsoftware.org/isdl.php" -ForegroundColor Red
    exit 1
}
Write-Host "  iscc: $iscc" -ForegroundColor Gray

& $iscc "installer\betacom-agent.iss"
if ($LASTEXITCODE -ne 0) {
    Write-Host "iscc fail (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

$out = Get-ChildItem "dist-installer\BetacomAgentSetup-*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $out) {
    Write-Host "Không tìm thấy output installer trong dist-installer\" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "==> XONG. Installer: $($out.FullName)" -ForegroundColor Green
Write-Host ("    Size: {0:N2} MB" -f ($out.Length / 1MB)) -ForegroundColor Gray
Write-Host ""
Write-Host "Giao khách: gửi 1 file .exe này + AGENT_CODE + AGENT_SECRET (lấy từ dashboard)." -ForegroundColor Yellow
