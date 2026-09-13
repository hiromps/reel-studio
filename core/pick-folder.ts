// エクスプローラーのフォルダ選択ダイアログを開く（ローカル専用ツールなのでサーバー側で開く）。
// 日本語パスが化けないよう、選択結果はコンソールではなく UTF-8 のファイル経由で受け取る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {exec} from './exec';

const PS_SCRIPT = `param([string]$Initial, [string]$Out)
$ErrorActionPreference = 'SilentlyContinue'
$selected = $null

# まず .NET の FolderBrowserDialog（Windows 10/11 では最新のピッカーになる）
try {
  Add-Type -AssemblyName System.Windows.Forms
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = '素材フォルダを選んでください'
  $dlg.ShowNewFolderButton = $false
  # SelectedPath を先に指定すると、そのフォルダを開いた状態でダイアログが出る
  if ($Initial -and (Test-Path -LiteralPath $Initial)) {
    $dlg.RootFolder = [System.Environment+SpecialFolder]::MyComputer
    $dlg.SelectedPath = $Initial
  }
  if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $selected = $dlg.SelectedPath }
  $owner.Dispose()
} catch { $selected = $null }

# 使えない環境では従来のシェルダイアログにフォールバック
if (-not $selected) {
  try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.BrowseForFolder(0, '素材フォルダを選んでください', 0, $Initial)
    if ($folder) { $selected = $folder.Self.Path }
  } catch { $selected = $null }
}

if ($selected) { [System.IO.File]::WriteAllText($Out, $selected, (New-Object System.Text.UTF8Encoding($false))) }
`;

export type PickFolderResult = {path: string | null; cancelled: boolean};

/** フォルダ選択ダイアログを開き、選ばれた絶対パスを返す。キャンセルなら path=null */
export async function pickFolder(initial?: string, timeoutMs = 180000): Promise<PickFolderResult> {
  if (process.platform !== 'win32') throw new Error('フォルダ選択ダイアログは Windows でのみ使えます');
  // FolderBrowserDialog.SelectedPath はスラッシュ区切りだと無視されるので、必ず Windows 形式に正規化する
  let start = '';
  if (initial) {
    try {
      const resolved = path.win32.resolve(initial);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) start = resolved;
    } catch {
      start = '';
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-pick-'));
  const script = path.join(dir, 'pick.ps1');
  const outFile = path.join(dir, `${randomUUID()}.txt`);
  try {
    // PowerShell 5.1 は BOM が無いと ANSI として読むため、UTF-8 BOM 付きで書く
    fs.writeFileSync(script, '﻿' + PS_SCRIPT, 'utf8');
    const r = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Initial', start, '-Out', outFile],
      {timeoutMs},
    );
    if (!fs.existsSync(outFile)) return {path: null, cancelled: true};
    const picked = fs.readFileSync(outFile, 'utf8').trim();
    if (!picked) return {path: null, cancelled: true};
    if (!fs.existsSync(picked)) throw new Error(`選ばれたフォルダが見つかりません: ${picked}（powershell 終了コード ${r.code}）`);
    return {path: path.resolve(picked), cancelled: false};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
