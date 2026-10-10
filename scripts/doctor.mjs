import fs from 'node:fs';
import path from 'node:path';
import {appRoot, runtimeFile} from './runtime.mjs';
import {probe} from './setup-lib.mjs';

const checks = [];
const check = (label, ok, detail) => checks.push({label, ok: !!ok, detail});
check('Node.js 22以上', Number(process.versions.node.split('.')[0]) >= 22, process.version);
check('npm', probe(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), '--version']), 'Node.jsに同梱');
for (const command of ['ffmpeg', 'ffprobe']) {
  const version = probe(command);
  check(command, version, version?.split(/\r?\n/)[0] ?? '未導入');
}
const audio = probe('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', '-af', 'speechnorm,loudnorm,alimiter,aresample=48000:resampler=soxr', '-c:a', 'aac', '-f', 'null', '-']);
check('音声合成（libsoxr/AAC/音量調整）', audio !== null, audio === null ? '対応したFFmpegのfull buildが必要です' : '正常');
let version;
for (const [dir, name] of [[appRoot, 'remotion'], [appRoot, '@remotion/player'], [path.join(appRoot, 'engine'), 'remotion'], [path.join(appRoot, 'engine'), '@remotion/cli']]) {
  let installed;
  try { installed = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { }
  version ??= installed;
  check(`${path.basename(dir)}/${name}`, installed && installed === version, installed ?? '未導入');
}
let tools = {};
try { tools = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); } catch { }
check('書き出し用Chrome', tools.browser && fs.existsSync(tools.browser), tools.browser ?? '未導入');
check('日本語フォント', fs.existsSync(path.join(appRoot, 'engine/public/fonts/NotoSerifJP-Bold.ttf')), 'Noto Serif JP');
check('編集画面のビルド', fs.existsSync(path.join(appRoot, 'dist/index.html')), 'dist/index.html');
for (const item of checks) console.log(`${item.ok ? 'OK' : 'NG'}  ${item.label}: ${item.detail}`);
console.log('\nAIは設定画面でClaude / DeepSeek / Codexに接続してください。音声生成はFish Audioのキーが必要です。');
if (checks.some((item) => !item.ok)) {
  console.error('不足があります。「Reel Studio セットアップ.cmd」または npm run setup を実行してください。');
  process.exitCode = 1;
}
