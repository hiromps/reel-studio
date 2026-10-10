import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {appRoot} from './runtime.mjs';

const require = createRequire(import.meta.url);
const {locations, backendEnvironment, checkFiles} = require('../desktop/runtime.cjs');
const executable = process.argv[2] || path.join(appRoot, 'desktop-out', 'win-unpacked', 'Reel Studio.exe');
const paths = locations(true, path.join(path.dirname(executable), 'resources'), appRoot);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'Reel Studio 確認 '));

function run(bin, args, env, cwd, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {cwd, env, stdio: 'inherit', windowsHide: true});
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
      else child.kill();
      reject(new Error('動作確認がタイムアウトしました。'));
    }, timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`動作確認が終了コード${code}で失敗しました。`)); });
  });
}

try {
  checkFiles(paths);
  const env = backendEnvironment(process.env, paths, path.join(home, 'data'), 'test-token', home);
  env.REEL_STUDIO_DATA_ROOT = path.join(home, 'data');
  // Deliberately hide global Node/npm/FFmpeg and inherited credentials.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = [path.dirname(paths.node), paths.ffmpeg, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter);
  for (const key of ['OPENAI_API_KEY', 'FISH_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'REEL_CLOUD_URL', 'REEL_WORKER_TOKEN']) delete env[key];
  await run(paths.node, ['--import', 'tsx', path.join(paths.backend, 'desktop', 'check-runtime.ts')], env, paths.backend);
  await run(executable, ['--smoke-test'], {...env, REEL_DESKTOP_TEST_HOME: home}, path.dirname(executable));
  const runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime-smoke.json'), 'utf8'));
  const electron = JSON.parse(fs.readFileSync(path.join(home, 'electron-smoke.json'), 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  if (electron.appVersion !== version) throw new Error(`アプリの版が一致しません: ${electron.appVersion} / ${version}`);
  if (!runtime.ok || !electron.ok || !electron.packaged || !electron.url.startsWith('http://127.0.0.1:')) throw new Error('デスクトップアプリの起動結果が一致しません。');
  const report = {ok: true, testedAt: new Date().toISOString(), executable, home, runtime, electron};
  fs.mkdirSync(path.join(appRoot, 'desktop-out'), {recursive: true});
  fs.writeFileSync(path.join(appRoot, 'desktop-out', 'verification.json'), JSON.stringify(report, null, 2));
  console.log(`\nデスクトップ版の動作確認OK（外部のNode.js/npm/FFmpegは未使用）\n${home}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
