param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$target = [IO.Path]::GetFullPath($Destination)
$boundary = $target.TrimEnd('\') + '\'
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  foreach ($entry in $zip.Entries) {
    $resolved = [IO.Path]::GetFullPath((Join-Path $target $entry.FullName))
    if (-not $resolved.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'The release archive contains an unsafe path.' }
  }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $Archive -DestinationPath $target
