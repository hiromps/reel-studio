// npm不要のNodeエントリ。Windowsのブートストラップからもランチャーからも使う。
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import os from 'node:os';
import {appRoot, runtimeFile, runtimeEnv} from './runtime.mjs';
import {ensureDependencies, probe, run, runNpm} from './setup-lib.mjs';

async function main() {
  process.chdir(appRoot);
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Node.js 22以上が必要です。「Reel Studio セットアップ.cmd」を実行してください。');
  }
  const args = new Set(process.argv.slice(2));
  let running = false;
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.REEL_STUDIO_PORT ?? 4310}/api/health`, {signal: AbortSignal.timeout(1500)});
    running = response.ok && (await response.json()).ok === true;
  } catch { /* 未起動 */ }
  if (running) throw new Error('Reel Studioが起動しています。起動用ウィンドウを閉じてからセットアップを再実行してください。');
  if (process.platform === 'win32' && !args.has('--tools-ready')) {
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(appRoot, 'scripts', 'bootstrap-windows.ps1'), '-ToolsOnly']);
  }
  ensureDependencies(appRoot, ['tsx/dist/cli.mjs', 'vite/bin/vite.js', 'remotion/package.json', '@openai/codex/bin/codex.js']);
  const engine = path.join(appRoot, 'engine');
  ensureDependencies(engine, ['@remotion/cli/remotion-cli.js', 'remotion/package.json']);
  const pkg = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
  const version = pkg(appRoot, 'remotion');
  if (pkg(appRoot, '@remotion/player') !== version || pkg(engine, 'remotion') !== version || pkg(engine, '@remotion/cli') !== version) {
    throw new Error('Remotionのバージョンが一致しません。package.json と lock を確認してください。');
  }
  for (const cmd of ['ffmpeg', 'ffprobe']) {
    if (!probe(cmd)) throw new Error(`${cmd} が使えません。Windowsではセットアップ.cmd、macOSでは brew install ffmpeg、Ubuntuでは sudo apt install ffmpeg を実行してください。`);
  }
  // 実際に使用する音声フィルタ/エンコーダ/soxrを起動して確かめる。
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', '-af', 'speechnorm,loudnorm,alimiter,aresample=48000:resampler=soxr', '-c:a', 'aac', '-f', 'null', '-']);
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:d=0.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'null', '-']);
  console.log('動画書き出し用のChrome Headless Shellを確認しています…');
  const require = createRequire(path.join(engine, 'package.json'));
  const {ensureBrowser} = require('@remotion/renderer');
  let tools = {};
  try {
    const record = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (record && typeof record === 'object') tools = record;
  } catch { /* 初回 */ }
  // 前回の自動導入パスは再検出する。npm ciや移動で消えたブラウザも修復する。
  const configuredBrowser = process.env.REEL_STUDIO_BROWSER_EXECUTABLE;
  const browser = await ensureBrowser({browserExecutable: configuredBrowser && configuredBrowser !== tools.browser ? configuredBrowser : null});
  if (!('path' in browser)) throw new Error('書き出し用ブラウザを導入できませんでした。');
  fs.mkdirSync(path.dirname(runtimeFile), {recursive: true});
  fs.writeFileSync(runtimeFile, JSON.stringify({...tools, browser: browser.path}, null, 2));
  Object.assign(process.env, runtimeEnv());
  // 新規利用者のデータを配布フォルダの外に保存する。既存設定・旧dataは変更しない。
  const settingsDir = process.env.REEL_STUDIO_HOME?.trim() || path.join(os.homedir(), '.reel-studio');
  const settingsFile = path.join(settingsDir, 'settings.json');
  const legacyData = path.join(appRoot, 'data');
  if (!fs.existsSync(settingsFile) && (!fs.existsSync(legacyData) || fs.readdirSync(legacyData).length === 0)) {
    fs.mkdirSync(settingsDir, {recursive: true});
    fs.writeFileSync(settingsFile, JSON.stringify({version: 1, dataRoot: path.join(os.homedir(), 'Reel Studio Data')}, null, 2), {flag: 'wx', mode: 0o600});
  }
  if (!args.has('--no-build')) runNpm(['run', 'build']);
  console.log('\nセットアップ完了。「Reel Studio.cmd」で起動できます。');
  console.log('手動編集とMP4書き出しにはAPIキーは不要です。AI・音声生成の接続は設定画面で行ってください。');
}

main().catch((error) => { console.error(`\nセットアップに失敗: ${error.message}`); process.exitCode = 1; });
