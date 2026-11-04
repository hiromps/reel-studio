param([Parameter(ValueFromRemainingArguments=$true)][string[]]$UpdateArgs)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$workspace = Split-Path -Parent $PSScriptRoot
$mutex = New-Object System.Threading.Mutex($false, 'Local\ReelStudioDesktopUpdate')
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) {
    Write-Host 'Another Reel Studio update is running. Waiting for it to finish...'
    try { $locked = $mutex.WaitOne() } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  }
  $development = @($UpdateArgs | Where-Object { $_ -in @('--source', '--local-build', '--build-only') }).Count -gt 0
  $source = $workspace
  if (-not $development) {
    $installed = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-desktop-update.ps1') -Inspect | ConvertFrom-Json
    $backend = Join-Path $installed.directory 'resources\backend'
    if (Test-Path -LiteralPath (Join-Path $backend 'scripts\update-released-desktop.mjs')) { $source = $backend }
    # Run outside the installed directory so Windows can replace the app's Node and scripts.
    $runner = Join-Path $env:LOCALAPPDATA 'Reel Studio Updater\current'
    New-Item -ItemType Directory -Force -Path (Join-Path $runner 'scripts'), (Join-Path $runner 'desktop') | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $source 'scripts') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runner 'scripts') -Force }
    Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $runner -Force
    Copy-Item -LiteralPath (Join-Path $source 'desktop\runtime.cjs') -Destination (Join-Path $runner 'desktop') -Force
  } else { $runner = $workspace }
  $node = Get-ChildItem -LiteralPath (Join-Path $workspace '.runtime\node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'node_modules\npm\bin\npm-cli.js') } | Select-Object -First 1
  if (-not $node) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $runner 'scripts\bootstrap-windows.ps1') -NodeOnly -PrivateNode
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the private update runtime. Please run the update again.' }
    $node = Get-ChildItem -LiteralPath (Join-Path $runner '.runtime\node') -Filter node.exe -Recurse | Select-Object -First 1
  }
  if (-not $node) { throw 'The private Node.js runtime was not found.' }
  $env:Path = $node.DirectoryName + ';' + $env:Path
  Set-Location -LiteralPath $runner
  & $node.FullName (Join-Path $runner 'scripts\update.mjs') '--desktop' "--workspace=$workspace" @UpdateArgs
  $updateExit = $LASTEXITCODE
} catch {
  Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red
  $updateExit = 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
exit $updateExit
