// Reel Studio ワンクリック起動。依存の導入・GUI のビルド・サーバー起動・ブラウザを開くところまでを 1 本で行う。
//   node scripts/launch.mjs            本番モード（dist を配信。ソースが新しければ自動でビルド）
//   node scripts/launch.mjs --dev      開発モード（Vite dev server :5173 を併用。HMR あり）
//   node scripts/launch.mjs --rebuild  dist を必ず作り直す
//   node scripts/launch.mjs --no-open  ブラウザを開かない
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const isWin = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const forceBuild = args.has('--rebuild');
const noOpen = args.has('--no-open');

const PORT = Number(process.env.REEL_STUDIO_PORT ?? 4310);
const VITE_PORT = 5173;
const url = dev ? `http://localhost:${VITE_PORT}/` : `http://localhost:${PORT}/`;

const C = {dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m'};
const log = (m) => console.log(`${C.cyan}▸${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const fail = (m) => console.log(`${C.red}✖${C.reset} ${m}`);
const ok = (m) => console.log(`${C.green}✔${C.reset} ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ディレクトリ配下の最終更新時刻（node_modules と dist は除く） */
const newestMtime = (dir, skip = new Set(['node_modules', 'dist', '.studio'])) => {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, {withFileTypes: true});
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return newest;
};

const needsBuild = () => {
  if (forceBuild) return true;
  const indexHtml = path.join(root, 'dist', 'index.html');
  if (!fs.existsSync(indexHtml)) return true;
  const built = fs.statSync(indexHtml).mtimeMs;
  const sources = Math.max(
    newestMtime(path.join(root, 'src')),
    newestMtime(path.join(root, 'shared')),
    fs.existsSync(path.join(root, 'index.html')) ? fs.statSync(path.join(root, 'index.html')).mtimeMs : 0,
    fs.existsSync(path.join(root, 'vite.config.ts')) ? fs.statSync(path.join(root, 'vite.config.ts')).mtimeMs : 0,
    // エンジン（テロップ描画）もバンドルに含まれる
    newestMtime(path.join(root, 'engine', 'src')),
  );
  return sources > built;
};

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const runNpm = (argv, label) => {
  log(label);
  const r = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...argv], {cwd: root, stdio: 'inherit', windowsHide: true})
    : spawnSync(isWin ? 'npm.cmd' : 'npm', argv, {cwd: root, stdio: 'inherit', windowsHide: true});
  if (r.status !== 0) throw new Error(`${label} に失敗しました（終了コード ${r.status}）`);
};

const alive = async (u, ms = 1200) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(u, {signal: ac.signal});
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
};

const waitFor = async (u, timeoutMs, label) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await alive(u)) return true;
    await sleep(400);
  }
  fail(`${label} が ${Math.round(timeoutMs / 1000)} 秒以内に応答しませんでした`);
  return false;
};

const openBrowser = (u) => {
  if (noOpen) return;
  if (isWin) spawn('cmd', ['/c', 'start', '', u], {detached: true, stdio: 'ignore', windowsHide: true}).unref();
  else if (process.platform === 'darwin') spawn('open', [u], {detached: true, stdio: 'ignore'}).unref();
  else spawn('xdg-open', [u], {detached: true, stdio: 'ignore'}).unref();
};

const children = [];
const killAll = () => {
  for (const c of children) {
    if (!c.pid || c.killed) continue;
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
      else process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
};

const startChild = (label, argv) => {
  const child = spawn(process.execPath, argv, {cwd: root, stdio: 'inherit', windowsHide: true, detached: !isWin});
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) fail(`${label} が終了しました（コード ${code}）`);
  });
  children.push(child);
  return child;
};

async function main() {
  console.log(`\n${C.cyan}Reel Studio${C.reset} ${C.dim}${root}${C.reset}\n`);

  if (!fs.existsSync(path.join(root, 'node_modules', 'remotion'))) {
    runNpm(['install', '--no-audit', '--no-fund'], '依存パッケージを導入しています（初回のみ・数分かかります）');
  }

  // すでに起動していれば、二重に立ち上げずブラウザだけ開く
  if (await alive(`http://127.0.0.1:${PORT}/api/health`)) {
    ok(`すでに起動しています → ${url}`);
    openBrowser(url);
    console.log(`\n${C.dim}このウィンドウは閉じて構いません。${C.reset}`);
    await sleep(2500);
    return;
  }

  if (!dev && needsBuild()) {
    runNpm(['run', 'build'], '画面をビルドしています');
  }

  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  log(`サーバーを起動しています（ポート ${PORT}）`);
  startChild('サーバー', [tsx, path.join(root, 'server', 'index.ts')]);
  if (!(await waitFor(`http://127.0.0.1:${PORT}/api/health`, 60000, 'サーバー'))) {
    killAll();
    process.exitCode = 1;
    return;
  }

  if (dev) {
    log(`Vite 開発サーバーを起動しています（ポート ${VITE_PORT}）`);
    startChild('Vite', [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(VITE_PORT), '--strictPort']);
    if (!(await waitFor(url, 60000, 'Vite'))) {
      killAll();
      process.exitCode = 1;
      return;
    }
  }

  ok(`起動しました → ${url}`);
  openBrowser(url);
  console.log(`\n${C.dim}終了するときはこのウィンドウを閉じるか Ctrl+C を押してください。${C.reset}\n`);

  await new Promise(() => {}); // 子プロセスが動いている間ここで待つ
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
  console.log('\n終了します…');
  killAll();
  process.exit(0);
});
process.on('exit', killAll);

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
  killAll();
  console.log(`\n${C.dim}エラー内容を確認したら、このウィンドウを閉じてください。${C.reset}`);
  // エラー時はウィンドウが即閉じないよう少し待つ
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], {stdio: 'ignore'});
  process.exitCode = 1;
});
