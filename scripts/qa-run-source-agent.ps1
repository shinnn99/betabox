$ErrorActionPreference = "Stop"

$projectRoot = "D:\beatbox\betabox"
$installedEnv = Join-Path $projectRoot "BetacomAgent\.env"
$recordingDir = Join-Path $projectRoot ".tmp\qa-recordings"

$config = @{}
foreach ($line in Get-Content -LiteralPath $installedEnv -Encoding utf8) {
  if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') {
    $config[$matches[1]] = $matches[2]
  }
}

foreach ($required in @("AGENT_CODE", "AGENT_SECRET")) {
  if (-not $config[$required]) {
    throw "Missing $required in installed agent environment"
  }
}

New-Item -ItemType Directory -Path $recordingDir -Force | Out-Null
$env:BACKEND_URL = "http://localhost:3000"
$env:AGENT_CODE = $config["AGENT_CODE"]
$env:AGENT_SECRET = $config["AGENT_SECRET"]
$env:SCANNERS_JSON = if ($config["SCANNERS_JSON"]) { $config["SCANNERS_JSON"] } else { "[]" }
$env:RECORDING_DIR = $recordingDir
$env:FFMPEG_PATH = Join-Path $projectRoot "BetacomAgent\ffmpeg.exe"
$env:FFPROBE_PATH = Join-Path $projectRoot "BetacomAgent\ffprobe.exe"
$env:LOG_EVENTS_ENABLED = "false"
$env:POLL_INTERVAL_MS = "1000"
$env:HEARTBEAT_INTERVAL_MS = "5000"
$env:CAMERA_PROBE_INTERVAL_MS = "5000"
$env:MAX_PROOF_CLIP_UPLOAD_BYTES = "157286400"

Set-Location -LiteralPath $projectRoot
Set-Location -LiteralPath (Join-Path $projectRoot "warehouse-agent")
& node --require ./scripts/node-userinfo-shim.cjs --import tsx src/index.ts
exit $LASTEXITCODE
