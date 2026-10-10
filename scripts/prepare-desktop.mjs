// Prepare a self-contained Windows x64 app. Only allowlisted source files and
// freshly installed production dependencies enter the distribution.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {appRoot} from './runtime.mjs';
import {run, runNpm} from './setup-lib.mjs';

const stage = path.join(appRoot, '.runtime', 'desktop-stage');
const assets = path.join(appRoot, '.runtime', 'desktop-assets');
const backend = path.join(stage, 'backend');
const licenses = path.join(stage, 'licenses');

async function downloadArchive(url, digest, destination) {
  fs.mkdirSync(assets, {recursive: true});
  const archive = path.join(assets, 'ffmpeg-9.0.2-full_build.zip');
  if (!fs.existsSync(archive) || createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== digest) {
    console.log('同梱するFFmpegを取得しています…');
    const response = await fetch(url, {signal: AbortSignal.timeout(300000)});
    if (!response.ok || !response.body) throw new Error(`FFmpeg取得に失敗: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
    if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== digest) throw new Error('FFmpegのSHA256が一致しません。');
  }
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(appRoot, 'scripts', 'extract-desktop.ps1'), '-Archive', archive, '-Destination', destination]);
}

function copy(from, to, exclude = []) {
  fs.cpSync(from, to, {recursive: true, filter: (src) => {
    const rel = path.relative(from, src);
    return !rel.split(path.sep).some((name) => exclude.includes(name) || name.startsWith('.env') || name === '.git' || name === '.runtime');
  }});
}

function collectLicenses(modules, prefix) {
  const packages = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const folder = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) { visit(folder); continue; }
      const manifest = path.join(folder, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      packages.push({name: pkg.name, version: pkg.version, license: pkg.license ?? 'See package license', repository: pkg.repository, homepage: pkg.homepage});
      for (const name of fs.readdirSync(folder)) {
        if (!/^(license|licence|notice|copying)(\.|$)/i.test(name) || !fs.statSync(path.join(folder, name)).isFile()) continue;
        const dst = path.join(licenses, prefix, pkg.name, name);
        fs.mkdirSync(path.dirname(dst), {recursive: true});
        fs.copyFileSync(path.join(folder, name), dst);
      }
      if (fs.existsSync(path.join(folder, 'node_modules'))) visit(path.join(folder, 'node_modules'));
    }
  };
  visit(modules);
  fs.writeFileSync(path.join(licenses, `${prefix}-packages.json`), JSON.stringify(packages, null, 2));
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Windows x64 / Node.js 22以上でビルドしてください。');
  // Electron 44 installs its binary explicitly rather than through npm postinstall.
  if (!fs.existsSync(path.join(appRoot, 'node_modules/electron/dist/electron.exe'))) run(process.execPath, [path.join(appRoot, 'node_modules/electron/install.js')]);
  console.log('編集画面をビルドしています…');
  runNpm(['run', 'build']);
  // The only recursive removal is this fixed, generated staging directory.
  if (path.dirname(stage) !== path.join(appRoot, '.runtime')) throw new Error('Invalid staging path');
  fs.rmSync(stage, {recursive: true, force: true});
  fs.mkdirSync(backend, {recursive: true});
  fs.mkdirSync(licenses, {recursive: true});
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  for (const dir of ['core', 'shared', 'server', 'worker', 'cloud', 'scripts']) copy(path.join(appRoot, dir), path.join(backend, dir), ['node_modules', 'out', 'dist']);
  for (const file of ['studio.config.ts', 'tsconfig.json', 'LICENSE', 'package-lock.json']) fs.copyFileSync(path.join(appRoot, file), path.join(backend, file));
  copy(path.join(appRoot, 'dist'), path.join(backend, 'dist'));
  copy(path.join(appRoot, 'engine'), path.join(backend, 'engine'), ['node_modules', 'out', '.studio']);
  fs.mkdirSync(path.join(backend, 'desktop'), {recursive: true});
  fs.copyFileSync(path.join(appRoot, 'desktop/check-runtime.ts'), path.join(backend, 'desktop/check-runtime.ts'));
  fs.writeFileSync(path.join(backend, 'package.json'), JSON.stringify({...pkg, main: undefined, scripts: {}, devDependencies: undefined, bin: undefined}, null, 2));
  console.log('アプリと動画エンジンの実行用部品を準備しています…');
  runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], backend);
  runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], path.join(backend, 'engine'));
  const app = path.join(stage, 'app');
  fs.mkdirSync(app, {recursive: true});
  for (const file of ['main.cjs', 'runtime.cjs', 'starting.html']) fs.copyFileSync(path.join(appRoot, 'desktop', file), path.join(app, file));
  fs.copyFileSync(path.join(appRoot, 'assets/reel-studio.svg'), path.join(app, 'reel-studio.svg'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({name: 'reel-studio-desktop', productName: 'Reel Studio', version: pkg.version, description: 'Reel Studio video editor', author: 'Reel Studio contributors', license: 'MIT', main: 'main.cjs'}, null, 2));
  const node = path.join(stage, 'runtime', 'node');
  fs.mkdirSync(node, {recursive: true});
  fs.copyFileSync(process.execPath, path.join(node, 'node.exe'));
  const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
  if (!fs.existsSync(nodeLicense)) throw new Error('Node.jsのLICENSEが見つかりません。公式のZIP版Node.jsを使用してください。');
  fs.copyFileSync(nodeLicense, path.join(licenses, 'Node.js-LICENSE.txt'));
  const ffmpegRoot = path.join(assets, 'ffmpeg', 'ffmpeg-9.0.2-full_build');
  const reused = [path.join(appRoot, '.runtime', 'ffmpeg', 'ffmpeg-9.0.2-full_build'), path.join(appRoot, '.runtime', 'clean-install', 'reel-studio', '.runtime', 'ffmpeg', 'ffmpeg-9.0.2-full_build')].find((dir) => fs.existsSync(path.join(dir, 'bin/ffprobe.exe')));
  if (!fs.existsSync(ffmpegRoot) && reused) copy(reused, ffmpegRoot);
  if (!fs.existsSync(path.join(ffmpegRoot, 'bin', 'ffprobe.exe'))) await downloadArchive('https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip', '759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b', path.dirname(ffmpegRoot));
  const ffmpeg = path.join(stage, 'runtime', 'ffmpeg', 'bin');
  fs.mkdirSync(ffmpeg, {recursive: true});
  for (const file of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(ffmpegRoot, 'bin', file), path.join(ffmpeg, file));
  for (const file of ['LICENSE', 'README.txt']) fs.copyFileSync(path.join(ffmpegRoot, file), path.join(licenses, `FFmpeg-${file}`));
  const require = createRequire(path.join(backend, 'engine', 'package.json'));
  const {ensureBrowser} = require('@remotion/renderer');
  process.chdir(appRoot);
  const browser = await ensureBrowser();
  if (!browser.path) throw new Error('書き出し用Chromeを準備できませんでした。');
  copy(path.dirname(browser.path), path.join(stage, 'runtime', 'chrome'));
  fs.copyFileSync(path.join(appRoot, 'LICENSE'), path.join(licenses, 'Reel-Studio-LICENSE.txt'));
  fs.copyFileSync(path.join(appRoot, 'engine/public/fonts/OFL_license.txt'), path.join(licenses, 'Noto-Serif-JP-OFL.txt'));
  fs.copyFileSync(path.join(appRoot, 'desktop/THIRD-PARTY-NOTICES.md'), path.join(licenses, 'THIRD-PARTY-NOTICES.md'));
  fs.copyFileSync(path.join(appRoot, 'docs/desktop.md'), path.join(licenses, 'Reel-Studio-Windows.md'));
  collectLicenses(path.join(backend, 'node_modules'), 'app');
  collectLicenses(path.join(backend, 'engine', 'node_modules'), 'engine');
  console.log(`デスクトップ配布用の準備完了: ${stage}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
