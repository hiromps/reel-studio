# Build from an explicit application allowlist; exclude user data and secrets.
$ErrorActionPreference = 'Stop'
$reelRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $reelRoot 'package.json') -Raw | ConvertFrom-Json).version
$releaseDir = Join-Path $reelRoot 'releases'
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$destination = Join-Path $releaseDir "Reel-Studio-$version-Windows.zip"
$temporary = Join-Path $releaseDir ([Guid]::NewGuid().ToString() + '.zip')
$directories = @('assets', 'bin', 'cli', 'core', 'shared', 'server', 'worker', 'cloud', 'src', 'engine', 'scripts', 'desktop', 'docs', 'public', 'api')
$rootFiles = @('package.json', 'package-lock.json', 'index.html', 'studio.config.ts', 'tsconfig.json', 'vite.config.ts', 'LICENSE', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md')
$files = @()
foreach ($name in $rootFiles) { $files += Get-Item -LiteralPath (Join-Path $reelRoot $name) }
$files += Get-ChildItem -LiteralPath $reelRoot -File -Filter '*.cmd'
function Get-ReleaseFiles([string]$Directory) {
  foreach ($item in (Get-ChildItem -LiteralPath $Directory)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing symbolic link in release: $($item.FullName)" }
    if ($item.PSIsContainer) {
      if ($item.Name -notin @('node_modules', '.runtime', '.studio', 'out', 'uploads', 'dist', 'fonts')) { Get-ReleaseFiles $item.FullName }
    } elseif ($item.Name -notmatch '^\.env|\.log$|^_app\.cjs$|^tools\.json$') { $item }
  }
}
foreach ($directory in $directories) { $files += Get-ReleaseFiles (Join-Path $reelRoot $directory) }
# Include the distributed engine font and its license explicitly.
foreach ($font in @('NotoSerifJP-Bold.ttf', 'OFL_license.txt')) {
  $files += Get-Item -LiteralPath (Join-Path $reelRoot "engine/public/fonts/$font")
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in ($files | Sort-Object FullName -Unique)) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing symbolic link in release: $($file.FullName)" }
    $relative = $file.FullName.Substring($reelRoot.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "reel-studio/$relative", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
Move-Item -LiteralPath $temporary -Destination $destination -Force
$digest = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$destination.sha256", "$digest  $([IO.Path]::GetFileName($destination))`n", (New-Object Text.UTF8Encoding($false)))
Write-Host "Created: $destination"
Write-Host "SHA256: $digest"
