param([switch]$ToolsOnly, [switch]$PrivateNode, [switch]$Launch, [switch]$Doctor, [switch]$ExportTest, [Parameter(ValueFromRemainingArguments=$true)][string[]]$LauncherArgs)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$reelRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $reelRoot '.runtime'

function Test-ReelTool([string]$Command, [string[]]$Arguments) {
  try {
    $output = & $Command @Arguments 2>&1
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function Get-VerifiedArchive([string]$Url, [string]$Digest, [string]$Destination) {
  if ($Digest -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid SHA256 checksum.' }
  $archive = Join-Path $runtimeRoot ([Guid]::NewGuid().ToString() + '.zip')
  try {
    Write-Host "Downloading: $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $Digest) { throw 'Download checksum mismatch. Please run setup again.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force
  } finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  }
}

try {
  if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This Windows release requires an x64 PC. Windows ARM64 is not supported by the bundled renderer.'
  }
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  Set-Location -LiteralPath $reelRoot
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $nodeBin = if ($nodeCommand) { $nodeCommand.Source } else { $null }
  $portableNode = Get-ChildItem -LiteralPath (Join-Path $runtimeRoot 'node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($portableNode) { $nodeBin = $portableNode.FullName }
  if ($PrivateNode -and -not $portableNode) { $nodeBin = $null }
  $nodeReady = $false
  if ($nodeBin) {
    $nodeReady = Test-ReelTool $nodeBin @('-e', 'process.exit(parseInt(process.versions.node)>=22?0:1)')
    $npmEntry = Join-Path (Split-Path -Parent $nodeBin) 'node_modules\npm\bin\npm-cli.js'
    $nodeReady = $nodeReady -and (Test-Path -LiteralPath $npmEntry)
  }
  if (-not $nodeReady) {
    Write-Host 'Installing private Node.js 24 LTS + npm (administrator rights are not required)...'
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
    $match = [regex]::Match($checksums, '(?m)^([a-f0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$')
    if (-not $match.Success) { throw 'Could not find the official Node.js archive checksum.' }
    Get-VerifiedArchive ('https://nodejs.org/dist/latest-v24.x/' + $match.Groups[2].Value) $match.Groups[1].Value (Join-Path $runtimeRoot 'node')
    $nodeBin = Join-Path (Join-Path $runtimeRoot 'node') ($match.Groups[2].Value.Replace('.zip', '') + '\node.exe')
  }
  $env:Path = (Split-Path -Parent $nodeBin) + ';' + $env:Path
  $toolsFile = Join-Path $runtimeRoot 'tools.json'
  $tools = @{}
  if (Test-Path -LiteralPath $toolsFile) {
    try { (Get-Content -LiteralPath $toolsFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $tools[$_.Name] = $_.Value } } catch { }
  }
  if ($tools.ffmpegDir -and (Test-Path -LiteralPath $tools.ffmpegDir)) { $env:Path = $tools.ffmpegDir + ';' + $env:Path }
  $ffmpegReady = Test-ReelTool 'ffmpeg' @('-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', '-af', 'speechnorm,loudnorm,alimiter,aresample=48000:resampler=soxr', '-c:a', 'aac', '-f', 'null', '-')
  $ffmpegReady = $ffmpegReady -and (Test-ReelTool 'ffprobe' @('-version'))
  if (-not $ffmpegReady) {
    Write-Host 'Installing private FFmpeg + FFprobe (full build with libsoxr)...'
    # Published GitHub release asset digest. Install full build: essentials lacks libsoxr.
    Get-VerifiedArchive 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip' '759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b' (Join-Path $runtimeRoot 'ffmpeg')
    $ffmpegBin = Get-ChildItem -LiteralPath (Join-Path $runtimeRoot 'ffmpeg') -Filter ffmpeg.exe -Recurse | Select-Object -First 1
    if (-not $ffmpegBin) { throw 'FFmpeg executable was not found in the archive.' }
    $env:Path = $ffmpegBin.DirectoryName + ';' + $env:Path
  }
  $tools.ffmpegDir = Split-Path -Parent (Get-Command ffmpeg -ErrorAction Stop).Source
  # UTF8 without BOM: Node's JSON.parse does not accept a BOM.
  [IO.File]::WriteAllText($toolsFile, ($tools | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  if ($ToolsOnly) { exit 0 }
  if ($Doctor -or $ExportTest) {
    $scriptName = if ($Doctor) { 'doctor.mjs' } else { 'smoke-export.mjs' }
    & $nodeBin (Join-Path $PSScriptRoot $scriptName)
    exit $LASTEXITCODE
  }
  if ($Launch) {
    & $nodeBin (Join-Path $PSScriptRoot 'launch.mjs') @LauncherArgs
    exit $LASTEXITCODE
  }
  & $nodeBin (Join-Path $PSScriptRoot 'setup.mjs') '--tools-ready'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-shortcut.ps1')
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Setup completed, but the desktop shortcut could not be created. Use Reel Studio.cmd.' }
  exit 0
} catch {
  Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
