// デスクトップ版への「すぐ反映」。インストーラーを作り直さず、変わったファイルだけをインストール先へ写す。
//
//   npm run desktop:quick                 … コミット済み（HEAD）の内容を反映する
//   npm run desktop:quick -- --working-tree … 作業フォルダの今の内容（未コミットも含む）を反映する
//   npm run desktop:quick -- --check      … 何が変わるかを見るだけ（書き込まない）
//
// 速い理由: サーバー側は TypeScript をそのまま tsx で動かしているので、画面（dist）だけビルドすれば
// あとはコピーで済む。配布用の梱包・自動の書き出し確認（合わせて約 10 分）は省く。
//
// 依存部品（package.json の dependencies / package-lock.json。engine も同じ）が変わったときは、インストール先で
// その場所だけ npm ci --omit=dev をやり直す（インストール版と同じ版の Node で。失敗したら元の node_modules に戻す）。
//
// 使えないとき（自動で止まる）: 版（package.json の version）やアプリ本体（Electron の main.cjs など
// app.asar の中身、desktop/runtime.cjs）が変わったとき。その場合は通常の更新（「Reel Studio 更新.cmd」）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {appRoot} from './runtime.mjs';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const workingTree = args.has('--working-tree');
const started = Date.now();
const log = (m) => console.log(`▸ ${m}`);
const fail = (m, code = 1) => { console.error(`✖ ${m}`); process.exit(code); };
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)} 秒`;

/** インストール先に写すもの（scripts/prepare-desktop.mjs と同じ並び） */
const DIRS = ['core', 'shared', 'server', 'worker', 'cloud', 'scripts', 'modal_backend', 'engine'];
const FILES = ['studio.config.ts', 'tsconfig.json'];
const SKIP = new Set(['node_modules', 'out', 'dist', '.studio', '__pycache__', '.git', '.runtime']);
const skipped = (name) => SKIP.has(name) || name.startsWith('.env');

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sameFile = (a, b) => fs.existsSync(b) && fs.statSync(a).size === fs.statSync(b).size && sha(a) === sha(b);
const sys = (name) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
const sh = (cmd, cmdArgs, opt = {}) => {
  const r = spawnSync(cmd, cmdArgs, {encoding: 'utf8', windowsHide: true, ...opt});
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${cmdArgs.slice(0, 2).join(' ')} に失敗: ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(-800)}`);
  return r.stdout;
};
const ps = (script) => sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);

const walk = (root, rel = '') => {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), {withFileTypes: true})) {
    if (skipped(e.name)) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
};

if (process.platform !== 'win32') fail('Windows 専用です');

// ---- インストール先と起動状態 ----
const inspect = () => JSON.parse(sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(appRoot, 'scripts', 'install-desktop-update.ps1'), '-Inspect']).trim());
const installed = inspect();
if (!installed.installed) fail('デスクトップ版がインストールされていません。先に通常の更新でインストールしてください');
const backend = path.join(installed.directory, 'resources', 'backend');
const asarFile = path.join(installed.directory, 'resources', 'app.asar');
if (!fs.existsSync(path.join(backend, 'server', 'index.ts'))) fail(`インストール先の形が想定と違います: ${backend}`);
if (installed.running && !checkOnly) fail('Reel Studio が起動しています。保存して閉じてから、もう一度実行してください（強制終了はしません）', 2);

// ---- 反映する中身を用意（既定はコミット済みの HEAD を別フォルダに取り出す） ----
let source = appRoot;
let label = '作業フォルダ（未コミットを含む）';
let cleanup = () => {};
if (!workingTree) {
  const head = sh('git', ['rev-parse', '--short', 'HEAD'], {cwd: appRoot}).trim();
  label = `コミット ${head}`;
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-quick-'));
  fs.rmSync(source, {recursive: true});
  sh('git', ['worktree', 'add', '--detach', source, 'HEAD'], {cwd: appRoot});
  // node_modules は本体のものを使う（ジャンクション）。片付けではジャンクションだけ外す
  const links = ['node_modules', path.join('engine', 'node_modules')];
  ps(links.map((l) => `New-Item -ItemType Junction -Path '${path.join(source, l)}' -Target '${path.join(appRoot, l)}' | Out-Null`).join('; '));
  cleanup = () => {
    for (const l of links) { try { fs.rmdirSync(path.join(source, l)); } catch { /* 無ければよい */ } }
    for (const l of links) if (fs.existsSync(path.join(source, l))) {
      console.error(`! ジャンクションを外せなかったので一時フォルダを残します: ${source}`);
      return;
    }
    spawnSync('git', ['worktree', 'remove', '--force', source], {cwd: appRoot, windowsHide: true});
  };
}

try {
  log(`反映元: ${label}`);
  log(`反映先: ${backend}`);

  // ---- すぐ反映できない変更が無いか（版・アプリ本体）。依存部品の変更はインストール先で入れ直して対応する ----
  const blockers = [];
  if (!sameFile(path.join(source, 'desktop', 'runtime.cjs'), path.join(backend, 'desktop', 'runtime.cjs'))) blockers.push('desktop/runtime.cjs');
  const readPkg = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const srcPkg = readPkg(path.join(source, 'package.json'));
  const dstPkg = readPkg(path.join(backend, 'package.json'));
  if (srcPkg.version !== dstPkg.version || srcPkg.type !== dstPkg.type) blockers.push('package.json（版の変更はリリースとして通常の更新で）');
  // 依存部品: 本体（backend）と engine それぞれ、package.json の dependencies か package-lock.json が変わっていれば入れ直す
  const depsChanged = (dir) => {
    const s = readPkg(path.join(source, dir, 'package.json'));
    const d = fs.existsSync(path.join(backend, dir, 'package.json')) ? readPkg(path.join(backend, dir, 'package.json')) : {};
    return JSON.stringify(s.dependencies ?? {}) !== JSON.stringify(d.dependencies ?? {}) || !sameFile(path.join(source, dir, 'package-lock.json'), path.join(backend, dir, 'package-lock.json'));
  };
  const depDirs = ['', 'engine'].filter(depsChanged);
  const asar = createRequire(path.join(appRoot, 'package.json'))('@electron/asar');
  for (const f of ['main.cjs', 'runtime.cjs', 'starting.html']) {
    const inside = asar.extractFile(asarFile, f);
    if (!inside.equals(fs.readFileSync(path.join(source, 'desktop', f)))) blockers.push(`desktop/${f}（アプリ本体）`);
  }
  if (blockers.length) {
    fail(`次が変わっているので、すぐ反映ではなく通常の更新が必要です（npm run desktop:update -- --local-build）:\n  - ${blockers.join('\n  - ')}`);
  }

  // ---- 変わったファイル ----
  const changed = [];
  const stale = [];
  for (const dir of DIRS) {
    const srcFiles = walk(source, dir);
    const srcSet = new Set(srcFiles);
    for (const rel of srcFiles) if (!sameFile(path.join(source, rel), path.join(backend, rel))) changed.push(rel);
    if (fs.existsSync(path.join(backend, dir))) for (const rel of walk(backend, dir)) if (!srcSet.has(rel)) stale.push(rel);
  }
  for (const f of FILES) if (!sameFile(path.join(source, f), path.join(backend, f))) changed.push(f);
  // 依存部品を入れ直すときは本体の package.json / package-lock.json も写す（engine のものは DIRS の走査で入る）
  if (depDirs.includes('')) for (const f of ['package.json', 'package-lock.json']) if (!sameFile(path.join(source, f), path.join(backend, f))) changed.push(f);
  log(`プログラムの変更: ${changed.length} ファイル${stale.length ? `（反映元に無い古いファイル ${stale.length} 件は残します）` : ''}`);
  for (const f of changed.slice(0, 30)) console.log(`    ${f.replaceAll('\\', '/')}`);
  if (changed.length > 30) console.log(`    …ほか ${changed.length - 30} 件`);
  if (depDirs.length) log(`依存部品の変更あり: ${depDirs.map((d) => d || '本体').join('・')} をインストール先で入れ直します（npm ci --omit=dev）`);

  // インストール版と同じ版の Node に付いている npm（作業フォルダの .runtime/node）。版がそろうのでネイティブ部品もずれない
  const appNode = path.join(installed.directory, 'resources', 'runtime', 'node', 'node.exe');
  const findNpmCli = () => {
    const ver = sh(appNode, ['-v']).trim().replace(/^v/, '');
    const candidates = [path.join(appRoot, '.runtime', 'node', `node-v${ver}-win-x64`), path.dirname(process.execPath)];
    for (const dir of candidates) {
      const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (fs.existsSync(cli)) return cli;
    }
    throw new Error(`インストール版の Node（v${ver}）に合う npm が見つかりません。通常の更新（「Reel Studio 更新.cmd」）を使ってください`);
  };
  const npmCli = depDirs.length ? findNpmCli() : null;
  if (checkOnly) { log('確認のみ（--check）なので書き込みません。画面のビルドもしていません'); process.exitCode = 0; }
  else {
    // ---- 画面をビルド（Vercel 用の api ビルドは要らないので省く） ----
    log('画面をビルドしています…');
    const node = process.execPath;
    sh(node, ['scripts/make-icon.mjs'], {cwd: source});
    sh(node, ['scripts/make-pwa-icons.mjs'], {cwd: source});
    sh(node, ['scripts/prepare-public.mjs'], {cwd: source});
    sh(node, [path.join(source, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], {cwd: source});
    const newDist = path.join(source, 'dist');
    if (!fs.existsSync(path.join(newDist, 'index.html'))) throw new Error('画面のビルド結果（dist/index.html）がありません');

    // ---- 控え → 反映 ----
    const backup = path.join(appRoot, '.runtime', 'desktop-quick-backups', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backup, {recursive: true});
    const added = [];
    for (const rel of changed) {
      const dst = path.join(backend, rel);
      if (fs.existsSync(dst)) { fs.mkdirSync(path.dirname(path.join(backup, rel)), {recursive: true}); fs.copyFileSync(dst, path.join(backup, rel)); }
      else added.push(rel);
    }
    fs.renameSync(path.join(backend, 'dist'), path.join(backup, 'dist'));
    // 依存部品を入れ直す場所の node_modules は控えへ退避（失敗したら戻す）。同じドライブなら移動だけで済む
    const move = (from, to) => {
      try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, {recursive: true}); fs.rmSync(from, {recursive: true, force: true}); }
    };
    const movedModules = [];
    const restore = () => {
      for (const rel of changed) {
        const saved = path.join(backup, rel);
        if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(backend, rel));
      }
      for (const rel of added) fs.rmSync(path.join(backend, rel), {force: true});
      fs.rmSync(path.join(backend, 'dist'), {recursive: true, force: true});
      fs.renameSync(path.join(backup, 'dist'), path.join(backend, 'dist'));
      for (const dir of movedModules) {
        fs.rmSync(path.join(backend, dir, 'node_modules'), {recursive: true, force: true});
        move(path.join(backup, dir, 'node_modules'), path.join(backend, dir, 'node_modules'));
      }
    };
    try {
      for (const rel of changed) {
        fs.mkdirSync(path.dirname(path.join(backend, rel)), {recursive: true});
        fs.copyFileSync(path.join(source, rel), path.join(backend, rel));
      }
      fs.cpSync(newDist, path.join(backend, 'dist'), {recursive: true});

      // ---- 依存部品の入れ直し（変わったところだけ。インストーラーは作り直さない） ----
      for (const dir of depDirs) {
        const at = path.join(backend, dir);
        log(`依存部品を入れ直しています: ${dir || '本体'}…`);
        if (fs.existsSync(path.join(at, 'node_modules'))) {
          fs.mkdirSync(path.join(backup, dir), {recursive: true});
          move(path.join(at, 'node_modules'), path.join(backup, dir, 'node_modules'));
          movedModules.push(dir);
        }
        const r = spawnSync(appNode, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], {cwd: at, encoding: 'utf8', windowsHide: true, timeout: 600000, env: {...process.env, PATH: `${path.dirname(appNode)};${process.env.PATH}`}});
        if (r.status !== 0) throw new Error(`依存部品の入れ直しに失敗しました（${dir || '本体'}）: ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(-800)}`);
        const missing = Object.keys(readPkg(path.join(at, 'package.json')).dependencies ?? {}).filter((name) => !fs.existsSync(path.join(at, 'node_modules', name, 'package.json')));
        if (missing.length) throw new Error(`入れ直した後も見つからない依存部品があります（${dir || '本体'}）: ${missing.join(', ')}`);
      }

      // ---- 簡単な確認: インストール版の Node でサーバーの部品を読み込めるか ----
      log('インストール版の Node でサーバーの部品を読み込んで確かめています…');
      // 読み込むだけで動き出すもの（server/index.ts・worker/index.ts）は避け、ルートと主要な処理の部品だけ読む
      const modules = ['./core/build.ts', './core/tts.ts', './core/mix.ts', './core/project.ts', ...fs.readdirSync(path.join(backend, 'server', 'routes')).filter((n) => n.endsWith('.ts')).map((n) => `./server/routes/${n}`)];
      const probe = `for (const m of ${JSON.stringify(modules)}) await import(m); console.log('probe-ok');`;
      const r = spawnSync(appNode, ['--import', 'tsx', '--input-type=module', '-e', probe], {cwd: backend, encoding: 'utf8', windowsHide: true, timeout: 120000});
      if (r.status !== 0 || !r.stdout.includes('probe-ok')) throw new Error(`読み込みに失敗しました: ${(r.stderr || r.stdout).trim().slice(-800)}`);
    } catch (error) {
      console.error('✖ 反映に失敗したので元に戻します');
      restore();
      throw error;
    }
    fs.writeFileSync(path.join(backend, 'quick-apply.json'), JSON.stringify({source: label, appliedAt: new Date().toISOString(), files: changed.map((f) => f.replaceAll('\\', '/')), dependencies: depDirs.map((d) => d || 'backend'), backup}, null, 2));
    log(`反映しました（${elapsed()}）。Reel Studio を起動すると新しい内容で動きます`);
    log(`元に戻すときの控え: ${backup}`);
    log('自動の書き出し確認は省いています。書き出しまわりを変えたときは一度書き出して確かめてください');
  }
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
