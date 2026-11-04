param([string]$Installer, [string]$ExpectedVersion, [switch]$Inspect)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$reelRoot = Split-Path -Parent $PSScriptRoot

function Get-ReelInstallation {
  $entries = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Reel Studio(?:\s|$)' })
  if ($entries.Count -gt 1) { throw 'Multiple Reel Studio installations found. Update the intended installation manually.' }
  $entry = $entries | Select-Object -First 1
  $directory = Join-Path $env:LOCALAPPDATA 'Programs\Reel Studio'
  if ($entry) {
    if ($entry.InstallLocation) { $directory = $entry.InstallLocation }
    elseif ($entry.UninstallString -match '^"([^"]+)"') { $directory = Split-Path -Parent $Matches[1] }
    else { throw 'Cannot determine the existing installation directory.' }
  }
  $executable = Join-Path $directory 'Reel Studio.exe'
  $running = @(Get-CimInstance Win32_Process -Filter "Name='Reel Studio.exe'" | Where-Object { $_.ExecutablePath -eq $executable }).Count -gt 0
  [pscustomobject]@{installed=[bool]$entry; version=$entry.DisplayVersion; directory=$directory; executable=$executable; running=$running}
}

try {
  $before = Get-ReelInstallation
  if ($Inspect) { $before | ConvertTo-Json -Compress; exit 0 }
  if ($before.running) { throw 'Reel Studio is running. Save your edits and close the app before updating.' }
  if (-not $Installer -or -not $ExpectedVersion) { throw 'Installer and ExpectedVersion are required.' }
  $installerFile = [IO.Path]::GetFullPath($Installer)
  $expectedFile = Join-Path $reelRoot "desktop-out\Reel-Studio-$ExpectedVersion-Setup.exe"
  if ($installerFile -ne [IO.Path]::GetFullPath($expectedFile) -or -not (Test-Path -LiteralPath $installerFile -PathType Leaf)) { throw 'The installer must be the freshly built release in desktop-out.' }
  # The unchanged appId lets NSIS retain the existing per-user install location.
  $process = Start-Process -FilePath $installerFile -ArgumentList @('/S', '/currentuser') -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)." }
  $after = Get-ReelInstallation
  if (-not $after.installed -or $after.version -ne $ExpectedVersion -or -not (Test-Path -LiteralPath $after.executable)) { throw 'Installed version verification failed.' }
  if ($before.installed -and $before.directory -ne $after.directory) { throw 'The installation directory changed unexpectedly.' }
  $after | ConvertTo-Json -Compress
  exit 0
} catch {
  Write-Host "Desktop update failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
