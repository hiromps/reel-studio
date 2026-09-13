# デスクトップに「Reel Studio」のショートカットを作る（再実行すると上書き）。
#   powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Dev        開発モード（HMR）で起動する版
#   powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Uninstall  削除
param(
  [switch]$Dev,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'Reel Studio.cmd'
$icon = Join-Path $root 'assets\reel-studio.ico'
$name = if ($Dev) { 'Reel Studio (dev)' } else { 'Reel Studio' }
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop "$name.lnk"

if ($Uninstall) {
  if (Test-Path $link) { Remove-Item $link -Force; Write-Host "削除しました: $link" }
  else { Write-Host "ショートカットはありません: $link" }
  exit 0
}

if (-not (Test-Path $target)) { throw "起動用ファイルが見つかりません: $target" }
if (-not (Test-Path $desktop)) { throw "デスクトップのフォルダが見つかりません: $desktop" }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = $target
if ($Dev) { $sc.Arguments = '--dev' }
$sc.WorkingDirectory = $root
$sc.WindowStyle = 1
$sc.Description = 'Reel Studio — グルメリールの素材カタログ・構成・プレビュー・レンダー'
if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
$sc.Save()

Write-Host "作成しました: $link"
Write-Host "  起動対象: $target $($sc.Arguments)"
Write-Host "  アイコン: $icon"
